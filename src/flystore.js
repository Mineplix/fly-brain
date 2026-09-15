// Persistent per-fly brains.
//
// WHAT IS ACTUALLY PER-FLY. The connectome itself is shared: one SharedArrayBuffer holding
// 165,122 neurons and 10.5M edges, read by every worker. Duplicating it per fly would cost
// ~40 MB each and is the whole reason several flies fit in a browser at all. What genuinely
// differs between two flies is the *learned* part -- the mushroom-body plastic overlay, one
// depression value per KC->MBON edge (29,169 floats, 114 kB). Two flies with different
// histories are two different animals precisely and only in this array.
//
// So a saved fly is: its identity (name, colour, sex), its body state (where it was, how much
// energy it had left) and its learned mushroom-body weights. Reloading one restores an animal
// that remembers what it learned last session. Deleting a fly deletes its record for good.
//
// WHY IndexedDB AND NOT FILES. A web page cannot write to arbitrary paths on disk. IndexedDB
// is the local, per-origin store that survives closing the browser, and each fly is one record
// keyed by its name -- so the store behaves exactly like a folder of files named after the
// flies, and that is how `exportFly`/`importFly` present it when you want real files on disk.

const DB_NAME = 'naf-flies';
const DB_VERSION = 1;
const STORE = 'brains';
export const FLY_EXT = '.naf-fly';

let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, DB_VERSION);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'name' });
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode), st = t.objectStore(STORE);
    let out;
    const r = fn(st);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

/** Signature of the current mushroom-body index. Weights saved against a different one are not
 *  the same array and must not be loaded into it -- see loadFly(). */
export const mbSignature = mushroom => (mushroom ? `${mushroom.nEdges}:${mushroom.nKC}:${mushroom.nMBON}` : 'none');

/** @returns {Promise<Array>} every saved fly, oldest first, without its weight blob. */
export async function listFlies() {
  const all = await tx('readonly', st => st.getAll());
  return (all || [])
    .map(({ mb, ...rest }) => ({ ...rest, bytes: mb ? mb.byteLength : 0 }))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/**
 * Load one fly by name.
 * @param {string} name
 * @param {string} sig  current mushroom-body signature; mismatched weights are dropped
 * @returns {Promise<object|null>} the record, with `mb` as an ArrayBuffer (or null if stale)
 */
export async function loadFly(name, sig) {
  const rec = await tx('readonly', st => st.get(name));
  if (!rec) return null;
  if (rec.mb && rec.mbSig !== sig) {
    // The connectome or the minimum-synapse threshold changed under this fly. Its weights index
    // a different edge list, so applying them would scramble the overlay. Keep the identity,
    // drop the brain, and say so rather than silently loading nonsense.
    console.warn(`[flystore] "${name}": saved brain is for index ${rec.mbSig}, current is ${sig} -- starting naive.`);
    rec.mb = null; rec.stale = true;
  }
  return rec;
}

/** Create or overwrite a fly's record. `mb` may be an ArrayBuffer, a Float32Array or null. */
export async function saveFly(rec) {
  const mb = rec.mb instanceof ArrayBuffer ? rec.mb : rec.mb?.buffer ? rec.mb.buffer.slice(0) : null;
  const row = { ...rec, mb, savedAt: Date.now(), createdAt: rec.createdAt || Date.now() };
  await tx('readwrite', st => st.put(row));
  return row;
}

/** Delete a fly's record for good. Called when a fly is removed or dies for keeps. */
export async function deleteFly(name) {
  await tx('readwrite', st => st.delete(name));
}

/**
 * Rename in place, carrying the brain across.
 *
 * @returns {Promise<'ok'|'taken'|'absent'>} These must NOT be conflated. 'absent' means the fly
 *   had no saved record yet, which is an ordinary rename that should simply proceed; 'taken'
 *   means another saved fly owns the target name and renaming would destroy its brain. An earlier
 *   version returned false for both, so renaming a never-saved fly was treated as a name clash --
 *   which reverted the rename and raised an alert(), and an alert() blocks a headless renderer
 *   forever. That hung an unattended verification run for 25 minutes.
 */
export async function renameStored(oldName, newName) {
  if (oldName === newName) return 'ok';
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, 'readwrite'), st = t.objectStore(STORE);
    const g = st.get(oldName);
    g.onsuccess = () => {
      const rec = g.result;
      const c = st.get(newName);
      c.onsuccess = () => {
        if (c.result) { res('taken'); return; }       // don't clobber another fly's brain
        if (!rec) { res('absent'); return; }          // nothing saved yet: the caller just carries on
        st.delete(oldName);
        st.put({ ...rec, name: newName });
        res('ok');
      };
    };
    t.onerror = () => rej(t.error);
  });
}

export async function clearAll() { await tx('readwrite', st => st.clear()); }

// ---- real files on disk, for backup and for moving a fly between machines -------------------
// Layout: a small JSON header, then the raw Float32 depression array.
//   [4 bytes: header length, little-endian uint32][header JSON, utf-8][mb weights, float32]

/** Serialise one record to a Blob you can save as `<name>.naf-fly`. */
export function encodeFly(rec) {
  const { mb, ...head } = rec;
  const json = new TextEncoder().encode(JSON.stringify({ ...head, format: 'naf-fly/1' }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, json.length, true);
  return new Blob(mb ? [len, json, mb] : [len, json], { type: 'application/octet-stream' });
}

/** Parse a `.naf-fly` file back into a record. */
export async function decodeFly(file) {
  const buf = await file.arrayBuffer();
  const n = new DataView(buf).getUint32(0, true);
  if (n <= 0 || n + 4 > buf.byteLength) throw new Error('not a .naf-fly file');
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
  if (head.format !== 'naf-fly/1') throw new Error(`unknown format ${head.format}`);
  const mb = buf.byteLength > 4 + n ? buf.slice(4 + n) : null;
  return { ...head, mb };
}

/** Prompt a download of one saved fly as `<name>.naf-fly`. */
export async function exportFly(name) {
  const rec = await tx('readonly', st => st.get(name));
  if (!rec) return false;
  const url = URL.createObjectURL(encodeFly(rec));
  const a = document.createElement('a');
  a.href = url; a.download = `${name.replace(/[^\w .-]+/g, '_')}${FLY_EXT}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}

// ---- one owner per browser profile ---------------------------------------------------------
// Two tabs of this app share one IndexedDB. Without a guard both would restore the same saved
// flies at startup and both would write back on their own timers, so each tab's autosave would
// overwrite the other's animals -- silently, and worst for exactly the long unattended runs
// this is meant to support. The first tab to open claims the store; later tabs run normally but
// with persistence off, and say so.
let channel = null;

/**
 * @returns {Promise<boolean>} true if this tab owns the store, false if another tab already does.
 */
export function claimStore(waitMs = 200) {
  if (typeof BroadcastChannel === 'undefined') return Promise.resolve(true);
  return new Promise(res => {
    const ch = new BroadcastChannel('naf-flies');
    let taken = false;
    ch.onmessage = e => {
      if (e.data?.type === 'here') { taken = true; return; }
      if (e.data?.type === 'who' && channel === ch) ch.postMessage({ type: 'here' });   // only the owner answers
    };
    ch.postMessage({ type: 'who' });
    setTimeout(() => {
      if (taken) { ch.close(); res(false); return; }
      channel = ch;                       // we are the owner; keep the channel open to answer later tabs
      res(true);
    }, waitMs);
  });
}

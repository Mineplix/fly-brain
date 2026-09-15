// Headless throughput harness.
//
// WHY THIS EXISTS. Every throughput number measured through arena.html carries three confounds
// that no amount of careful windowing removes (FIELD-NOTES 24, 26, 27):
//
//   1. RENDERING. The arena builds a THREE scene, shadow maps, a 165k-point brain inset and a
//      per-fly neural stack. An adaptive resolution scaler then changes render load as the scene
//      cost changes, which silently varies how much CPU the workers get between conditions.
//   2. THROTTLING. A backgrounded tab runs the worker timers ~40x slower (0.0366x -> 0.0009x
//      measured on the same page minutes apart), so any unattended wait corrupts the run.
//   3. DRIFT. Repeat measurements at identical settings differed by ~25%, which exceeded most
//      of the differences being interpreted.
//
// This page loads the connectome and the workers and NOTHING else: no THREE, no canvas, no
// scene, no brain panel, no fly meshes. It is the same simulation path with the renderer
// removed, so what it measures is the simulation.
//
// It cannot fix throttling on its own -- that is a browser policy and applies to any page -- so
// it reports whether the document was ever hidden during a run and marks the result dirty if so.
// Run it in a foreground window.
//
// USAGE
//   bench.html?flies=1,2,3,4,5,6         fly counts to sweep (default 1..6)
//   &repeats=3                            measurement windows per point (default 3)
//   &window=20                            seconds of wall time per window (default 20)
//   &warm=2                               discarded warm windows per point (default 2)
//   &order=random                         randomise point order (default: as listed)
//   &vision=0  &props=0  &gpu=0           passed through to the flies, as in the arena

import { loadConnectome } from './data.js';
import { PRESETS, DEFAULT_ENV } from './sim/world.js';
import { allocBrainMemory, MAX_FLIES } from './brainsetup.js';
import { parseFlyVis } from './flyvis.js';
import { buildMushroomIndex } from './sim/mushroom.js';

const BASE = import.meta.env.BASE_URL;
const Q = new URLSearchParams(location.search);
const num = (k, d) => { const v = Number(Q.get(k)); return Number.isFinite(v) && v > 0 ? v : d; };

const POINTS = (Q.get('flies') || '1,2,3,4,5,6').split(',').map(Number)
  .filter(n => n >= 1 && n <= MAX_FLIES);
const REPEATS = num('repeats', 3);
const WINDOW_MS = num('window', 20) * 1000;
const WARM = Q.get('warm') === '0' ? 0 : num('warm', 2);
const RANDOM = Q.get('order') === 'random';
const NO_VISION = Q.get('vision') === '0';
const PROPS_ON = Q.get('props') !== '0';

const out = document.getElementById('out');
const log = s => { out.textContent += s + '\n'; out.scrollTop = out.scrollHeight; console.info(s); };
const status = s => { document.getElementById('status').textContent = s; };

// ---- throttle watchdog -------------------------------------------------------------------
// A hidden tab throttles the worker timers. Rather than silently producing a slow number, the
// run records it and every affected result is marked dirty.
let hiddenSeen = false;
document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenSeen = true; });

// ---- the same furniture the arena stages, so the comparison is like for like ---------------
function spiralStaircase({ x, y, color, pole, dais }) {
  const N = 22, rise = 0.062, turn = Math.PI / 6, rHelix = 0.34, o = [];
  if (dais) o.push({ type: 'cylinder', x, y, r: 0.62, sz: 0.045, color: dais });
  for (let k = 0; k < N; k++) { const th = k * turn;
    o.push({ type: 'box', x: x + rHelix * Math.cos(th), y: y + rHelix * Math.sin(th),
      z: 0.045 + k * rise, sx: 0.22, sy: 0.055, sz: 0.03, yaw: th, color }); }
  o.push({ type: 'cylinder', x, y, r: 0.06, sz: (N - 1) * rise + 0.12, z: 0.045, color: pole });
  return o;
}
function carnivalProps() {
  const o = [];
  [[-1.55, 0.95, 0.52], [1.45, 1.05, 0.44], [1.75, -0.55, 0.60], [-1.15, -1.55, 0.40]]
    .forEach(([x, y, h]) => { o.push({ type: 'cylinder', x, y, r: 0.045, sz: h });
                              o.push({ type: 'cylinder', x, y, r: 0.20, sz: 0.035, z: h }); });
  [[0.95, -1.65], [-1.85, -0.35]].forEach(([x, y]) => {
    o.push({ type: 'box', x, y, sx: 0.17, sy: 0.17, sz: 0.24 });
    o.push({ type: 'box', x: x + 0.05, y: y - 0.04, sx: 0.12, sy: 0.12, sz: 0.18, z: 0.24 }); });
  [[0.42, 0.10, 0], [0.31, 0.09, 0.10], [0.20, 0.08, 0.19]]
    .forEach(([r, h, z]) => o.push({ type: 'cylinder', x: -1.7, y: 1.75, r, sz: h, z }));
  [[0.55, 0.95], [-0.45, -0.95], [1.15, 0.25], [-0.85, 0.35], [0.25, 1.65], [1.85, 1.65]]
    .forEach(([x, y], i) => o.push({ type: 'box', x, y, sx: 0.10, sy: 0.10, sz: 0.13 + 0.05 * (i % 3) }));
  return o;
}
function wallProps(radius, wallHeight) {
  const o = [], N = 10, rIn = radius - 0.13;
  for (let k = 0; k < N; k++) {
    const th = (k + 0.5) / N * 2 * Math.PI, deep = k % 2 === 0;
    o.push({ type: 'box', x: rIn * Math.cos(th), y: rIn * Math.sin(th), yaw: th,
      sx: deep ? 0.10 : 0.05, sy: deep ? 0.20 : 0.26, sz: deep ? 0.05 : 0.14,
      z: wallHeight * (deep ? 0.62 : 0.70) });
  }
  return o;
}

// The arena's circus reflectances, so the flies' vision sees the same scene it would there.
const LOOK_ALBEDO = { floorLo: 0.126, floorHi: 0.92, wallLo: 0.29, wallHi: 0.77 };

let shared, meta, bodymap, flyXML, gait, brainMem, wasmModule, brainParams, neuromodCalib,
    flyvisMap, mushroom, env;
const flies = [];

async function setup() {
  status('loading connectome');
  const data = await loadConnectome(status);
  meta = data.meta;
  status('loading body model');
  // Only the simulation's inputs. No blender fly, no arena detail, no cuticle textures.
  const [bm, xml, g, sz, sg, bp, wasmBytes, fvb, fvj, fvi, fvm, nmc] = await Promise.all([
    fetch(`${BASE}data/bodymap.json`).then(r => r.json()),
    fetch(`${BASE}body/fly_physics.xml`).then(r => r.text()),
    fetch(`${BASE}body/gait.json`).then(r => r.json()),
    fetch(`${BASE}data/neuron_size.bin`).then(r => r.arrayBuffer()),
    fetch(`${BASE}data/ntsign.bin`).then(r => r.arrayBuffer()),
    fetch(`${BASE}data/brain_params.json`).then(r => r.ok ? r.json() : {}).catch(() => ({})),
    fetch(`${BASE}lif.wasm`).then(r => r.arrayBuffer()),
    fetch(`${BASE}vision/flyvis.bin`).then(r => r.arrayBuffer()),
    fetch(`${BASE}vision/flyvis.json`).then(r => r.json()),
    fetch(`${BASE}vision/flyvis_inputs.json`).then(r => r.json()),
    fetch(`${BASE}vision/flyvis_map.json`).then(r => r.json()),
    fetch(`${BASE}data/neuromod.json`).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  const vision = NO_VISION ? null : { model: parseFlyVis(fvb, fvj, fvi), map: fvm };
  bodymap = bm; flyXML = xml; gait = g; flyvisMap = fvm; neuromodCalib = nmc;
  const toShared = ta => { const sab = new SharedArrayBuffer(ta.byteLength); const o = new ta.constructor(sab); o.set(ta); return o; };
  shared = { N: data.N, E: data.E, indptr: toShared(data.indptr), indices: toShared(data.indices),
    weights: toShared(data.weights), nt: toShared(data.nt), side: toShared(data.side),
    superclass: toShared(data.superclass), cls: toShared(data.cls),
    size: toShared(new Float32Array(sz)), sign: toShared(new Float32Array(sg)) };
  brainParams = { ...bp, neuromod: !!(bp.neuromod && nmc) };
  if (Q.get('gpu') === '0') brainParams.gpu = false;
  wasmModule = await WebAssembly.compile(wasmBytes);
  status('writing connectome into shared memory');
  brainMem = allocBrainMemory({ ...data, superclass: data.superclass }, shared.size, shared.sign, brainParams, MAX_FLIES, vision);
  mushroom = buildMushroomIndex(data, brainMem.memory, brainMem.graph);

  // Staged exactly as arena.js stages the circus theme: the preset's own block is KEPT (the
  // arena appends rather than replaces) and the staircase carries its dais. Any difference here
  // is a difference in what is being benchmarked, so the obstacle count is asserted below.
  env = structuredClone(DEFAULT_ENV);
  env.obstacles.push(...spiralStaircase({ x: -0.15, y: -0.15, dais: true }));
  if (PROPS_ON) env.obstacles.push(...carnivalProps(), ...wallProps(env.arena.radius, env.arena.wallHeight));
  const expect = PROPS_ON ? 56 : 25;
  if (env.obstacles.length !== expect)
    log(`WARNING: ${env.obstacles.length} obstacles, expected ${expect} -- this bench is no longer staged like the arena`);
  status(`ready -- ${env.obstacles.length} obstacles, vision ${NO_VISION ? 'off' : 'on'}, backend ${brainParams.gpu === false ? 'wasm' : 'auto'}`);
}

function addFly(id, pos, yaw) {
  const worker = new Worker(new URL('./sim/fly.worker.js', import.meta.url), { type: 'module' });
  const f = { id, worker, t: 0, ready: false, alive: true };
  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'ready') { f.ready = true; f.onReady?.(); }
    else if (m.type === 'pose') { f.t = m.t; f.alive = m.alive !== false; }
  };
  worker.postMessage({ type: 'init', id, graph: shared, meta, bodymap, flyXML, gait, env,
    pos, yaw, nProxies: MAX_FLIES - 1, mode: 'descending', brainOpts: brainParams,
    neuromod: neuromodCalib, vision: !NO_VISION, sex: 'm', look: LOOK_ALBEDO,
    brainMem: { memory: brainMem.memory, graph: brainMem.graph, bases: brainMem.bases, opts: brainMem.opts, fv: brainMem.fv },
    wasmModule, slot: id, flyvisMap, mushroom, learn: true, etaMul: 1, noci: Q.get('noci') === '1' });
  flies.push(f);
  return new Promise(res => { f.onReady = () => res(f); });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One measurement window: aggregate simulated seconds per wall second across all flies. */
async function windowRate(ms) {
  const t0 = flies.map(f => f.t), w0 = performance.now();
  await sleep(ms);
  const dw = performance.now() - w0;
  const per = flies.map((f, i) => (f.t - t0[i]) / dw);
  return { per, agg: per.reduce((s, x) => s + x, 0) };
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function run() {
  await setup();
  log(`headless bench -- ${env.obstacles.length} obstacles, vision ${NO_VISION ? 'OFF' : 'ON'}`);
  log(`points [${POINTS.join(', ')}]  repeats ${REPEATS}  window ${WINDOW_MS / 1000}s  warm ${WARM}`);
  log('');

  const order = RANDOM ? [...POINTS].sort(() => Math.random() - 0.5) : POINTS;
  const rows = [];
  for (const n of order) {
    while (flies.length < n) {
      const th = Math.random() * 6.283, r = 0.6 + Math.random();
      status(`starting fly ${flies.length + 1}/${n}`);
      await addFly(flies.length, [r * Math.cos(th), r * Math.sin(th)], Math.random() * 6.283);
      flies[flies.length - 1].worker.postMessage({ type: 'run' });
      flies[flies.length - 1].worker.postMessage({ type: 'speed', speed: 2 });
    }
    hiddenSeen = false;
    status(`${n} flies: settling`);
    await sleep(10000);
    for (let k = 0; k < WARM; k++) await windowRate(WINDOW_MS);
    const runs = [];
    for (let k = 0; k < REPEATS; k++) {
      status(`${n} flies: window ${k + 1}/${REPEATS}`);
      runs.push((await windowRate(WINDOW_MS)).agg);
    }
    const med = median(runs), lo = Math.min(...runs), hi = Math.max(...runs);
    const spread = med > 0 ? (hi - lo) / med : 0;
    const dead = flies.filter(f => !f.alive).length;
    rows.push({ flies: n, aggregate: +med.toFixed(5), perFly: +(med / n).toFixed(5),
      runs: runs.map(x => +x.toFixed(5)), spreadPct: +(100 * spread).toFixed(1),
      dirty: hiddenSeen, dead });
    log(`${String(n).padStart(2)} flies   agg ${med.toFixed(5)}   per-fly ${(med / n).toFixed(5)}`
      + `   spread ${(100 * spread).toFixed(1)}%${hiddenSeen ? '   ** TAB WAS HIDDEN -- DIRTY **' : ''}`
      + `${dead ? `   ${dead} dead` : ''}`);
  }

  log('');
  log('flies,aggregate,perFly,spreadPct,dirty,dead');
  for (const r of rows.sort((a, b) => a.flies - b.flies))
    log(`${r.flies},${r.aggregate},${r.perFly},${r.spreadPct},${r.dirty},${r.dead}`);
  const anyDirty = rows.some(r => r.dirty);
  log('');
  log(anyDirty
    ? 'AT LEAST ONE POINT IS DIRTY: the tab lost focus and its workers were throttled. Re-run it in a foreground window.'
    : 'No point saw a hidden tab.');
  status('done');
  window.__benchRows = rows;
  document.title = 'bench done';
}

run().catch(e => { status('error'); log(String(e && e.stack || e)); });

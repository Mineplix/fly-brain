// Thermal escape: does the simulated fly get off a hot floor, and how?
//
// This is the first BEHAVIOURAL VALIDATION experiment in the project. Everything measured so far
// has been internal consistency — synapses changed, weights persisted, rays hit an object. None of
// it asks whether the animal behaves like a fly. This does, and the real-fly answer is documented,
// so the result can be wrong in a way that means something.
//
// WHAT IS BEING ASKED
//   1. Does it escape at all?          mean and peak height above the floor
//   2. By what route?                  flight (takeoffs, flight fraction) vs climbing (height
//                                      gained while not flying) vs neither
//   3. How fast?                       latency from flood onset to the first real height gain
//   4. Does it seek relief?            fraction of time below the nociceptive floor, given that
//                                      heat decays with height
//   5. Does it stay up?                height during the post period, after the floor has cooled
//
// THE CONTROL IS THE EXPERIMENT. Flies climb furniture anyway. Without a no-lava condition run in
// the same session, any height gain reads as escape — which is exactly how the defensive-arousal
// result went wrong (FIELD-NOTES 25). Condition order is randomised so the comparison is not
// confounded with time, and each condition's own baseline is reported so drift is visible.
//
// NOTE ON WHAT THIS CANNOT SHOW. Escape here would be produced by thermosensory drive propagating
// through the connectome to descending neurons. The motor layer reads ~18 named descending types
// out of 1,314, so a negative result may mean "the fly does not escape" OR "the escape command
// exists but is not read". Both are findings; they are not the same finding.
//
//   arena.html?thermal=1&flies=3

const A = window.__arena;

const box = document.createElement('div');
box.style.cssText = `position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:99999;
  background:#0b0f16;color:#e6edf3;border:2px solid #ff6a3a;border-radius:12px;padding:20px 24px;
  font:12px/1.5 ui-monospace,Consolas,monospace;box-shadow:0 20px 60px rgba(0,0,0,.8);
  min-width:660px;max-height:88vh;overflow:auto;white-space:pre`;
document.body.appendChild(box);
let head = 'THERMAL ESCAPE', lines = [], colour = '#ff6a3a';
const paint = () => { box.style.borderColor = colour;
  box.innerHTML = `<div style="font-size:15px;font-weight:700;color:${colour};margin-bottom:10px">${head}</div>`
    + lines.map(l => `<div>${l}</div>`).join(''); };
const say = l => { lines.push(l); paint(); console.info('[thermal] ' + l); };
const fail = e => { colour = '#f87171'; head = 'ERROR'; say(''); say(String((e && e.stack) || e)); };
paint();
window.addEventListener('unhandledrejection', ev => fail(ev.reason));

const Q = new URLSearchParams(location.search);
const WASH_S = Number(Q.get('wash')) || 2;
const BASE_S = Number(Q.get('base')) || 3;
const HOT_S  = Number(Q.get('hot'))  || 6;
const POST_S = Number(Q.get('post')) || 4;
const NOCI_FLOOR = 0.06;                     // below this the nociceptive channel is silent
const HEAT_Z = 0.28;                         // must match senses.js

const flies = () => A.flies;
const simS = () => (A.flies[0]?.last?.t || 0) / 1000;
const anyDead = () => A.flies.some(f => f.last && f.last.alive === false);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The heat a point actually feels, mirroring senses.js including the height falloff. */
function heatAt(p) {
  let h = 0;
  for (const z of A.env.hazards) {
    const d = Math.hypot(p[0] - z.x, p[1] - z.y);
    h = Math.max(h, z.heat * Math.max(0, 1 - Math.max(0, d - z.r) / 0.4));
  }
  return h * Math.exp(-Math.max(0, p[2] || 0) / HEAT_Z);
}

async function advance(dt, maxWallMs = 600000) {
  const t0 = simS(), w0 = performance.now();
  while (simS() < t0 + dt) {
    if (anyDead() || performance.now() - w0 > maxWallMs) return false;
    await sleep(150);
  }
  return true;
}

/**
 * Sample every fly over a span of simulated time.
 * Height is the headline measure because heat decays with height: getting up IS escaping.
 */
async function measure(dt, onSample) {
  const t0 = simS(), w0 = performance.now();
  const st = flies().map(f => ({ name: f.name, n: 0, z: 0, zMax: 0, safe: 0, flying: 0,
    heat: 0, gf: 0, jumps0: f.last?.jumps ?? 0, flights0: f.last?.flights ?? 0, climbed: 0, lastZ: null }));
  while (simS() < t0 + dt) {
    if (anyDead() || performance.now() - w0 > 600000) break;
    await sleep(100);
    flies().forEach((f, i) => {
      const s = f.last; if (!s) return; const q = st[i];
      const z = s.pos[2], h = heatAt(s.pos);
      q.n++; q.z += z; q.zMax = Math.max(q.zMax, z); q.heat += h;
      if (h < NOCI_FLOOR) q.safe++;
      if (s.flying) q.flying++;
      else if (q.lastZ !== null && z > q.lastZ) q.climbed += z - q.lastZ;   // height gained on foot
      q.lastZ = z;
      q.gf = Math.max(q.gf, s.cmd?.escape || 0);
      onSample?.(i, z, h, s);
    });
  }
  return st.map((q, i) => {
    const s = flies()[i]?.last;
    return { fly: q.name,
      z: +(q.z / Math.max(1, q.n)).toFixed(3), zMax: +q.zMax.toFixed(3),
      safePct: +(100 * q.safe / Math.max(1, q.n)).toFixed(0),
      flyPct: +(100 * q.flying / Math.max(1, q.n)).toFixed(0),
      heat: +(q.heat / Math.max(1, q.n)).toFixed(3),
      climbed: +q.climbed.toFixed(2),
      takeoffs: (s?.jumps ?? 0) - q.jumps0,
      flights: (s?.flights ?? 0) - q.flights0,
      gfPeak: +q.gf.toFixed(0) };
  });
}

const fmt = rows => rows.map(r =>
  `${String(r.fly).padEnd(7)} z ${r.z.toFixed(3)} (max ${r.zMax.toFixed(2)})  safe ${String(r.safePct).padStart(3)}%  ` +
  `fly ${String(r.flyPct).padStart(3)}%  climb ${r.climbed.toFixed(2)}  heat ${r.heat.toFixed(3)}  ` +
  `takeoff ${r.takeoffs}  GF ${r.gfPeak}Hz`);

async function condition(lava) {
  const tag = lava ? 'LAVA' : 'control';
  say(''); say(`--- ${tag} ---`);
  A.setLava?.(false);
  A.env.food = [{ x: 0, y: 0, r: 1.6, sugar: 1, bitter: 0, water: 0.3, amount: 999 }];
  A.env.odors = [{ x: 0, y: 0, odor: 'vinegar', strength: 0.7, sigma: 3 }];
  A.env.bitterPatches = []; A.env.wind = [0, 0];
  A.rebuildEnv();
  for (const f of A.flies) if (f.ready) f.worker.postMessage({ type: 'env', env: A.env });
  if (!await advance(WASH_S)) return null;

  const base = await measure(BASE_S);
  say('  baseline'); fmt(base).forEach(l => say('    ' + l));
  const baseZ = base.reduce((s, r) => s + r.z, 0) / base.length;

  // treatment. Latency is measured from the moment the floor starts to flood.
  if (lava) A.setLava(true);
  const onsetSim = simS();
  const firstRise = flies().map(() => null);
  const treat = await measure(HOT_S, (i, z) => {
    if (firstRise[i] === null && z > base[i].z + 0.06) firstRise[i] = simS() - onsetSim;
  });
  say(`  ${lava ? 'flooded' : 'no lava'}`); fmt(treat).forEach(l => say('    ' + l));
  say('    latency to +0.06 cm: ' + firstRise.map(v => v === null ? 'never' : v.toFixed(2) + 's').join('  '));

  if (lava) A.setLava(false);
  const post = await measure(POST_S);
  say('  after cooling'); fmt(post).forEach(l => say('    ' + l));

  return { lava, base, treat, post, baseZ, firstRise };
}

(async () => {
  try {
    say(`flies ${flies().length}   heat falls off with height (scale ${HEAT_Z} cm), so height IS escape`);
    say(`washout ${WASH_S}s, baseline ${BASE_S}s, treatment ${HOT_S}s, post ${POST_S}s — simulated time`);
    const order = Math.random() < 0.5 ? [false, true] : [true, false];
    say(`order this run: ${order.map(l => l ? 'LAVA' : 'control').join(' -> ')}  (randomised)`);
    say('');
    say('waiting for warm-up...');
    while (simS() < 5) { if (anyDead()) throw new Error('a fly died before the run started'); await sleep(500); }

    const out = [];
    for (const l of order) { const r = await condition(l); if (r) out.push(r); if (anyDead()) break; }
    A.setLava?.(false);

    const ctrl = out.find(r => !r.lava), hot = out.find(r => r.lava);
    say(''); say('=== verdict ===');
    if (!ctrl || !hot) { say('a condition is missing — nothing here is interpretable.'); }
    else {
      const mean = (rows, k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
      const dz = mean(hot.treat, 'z') - mean(ctrl.treat, 'z');
      const dsafe = mean(hot.treat, 'safePct') - mean(ctrl.treat, 'safePct');
      const dfly = mean(hot.treat, 'flyPct') - mean(ctrl.treat, 'flyPct');
      const dclimb = mean(hot.treat, 'climbed') - mean(ctrl.treat, 'climbed');
      const drift = Math.abs(mean(hot.base, 'z') - mean(ctrl.base, 'z'));
      say(`  baseline height drift between conditions: ${drift.toFixed(3)} cm`);
      if (drift > 0.05) say('  THAT IS LARGE relative to the effect being measured — treat the rest with suspicion.');
      say(`  height,      lava vs control:  ${dz >= 0 ? '+' : ''}${dz.toFixed(3)} cm`);
      say(`  time safe,   lava vs control:  ${dsafe >= 0 ? '+' : ''}${dsafe.toFixed(0)} %`);
      say(`  flight,      lava vs control:  ${dfly >= 0 ? '+' : ''}${dfly.toFixed(0)} %`);
      say(`  climbing,    lava vs control:  ${dclimb >= 0 ? '+' : ''}${dclimb.toFixed(2)} cm`);
      const lat = hot.firstRise.filter(v => v !== null);
      say(`  escaped (rose >0.06 cm): ${lat.length} of ${hot.firstRise.length}` +
          (lat.length ? `, median latency ${lat.sort((a, b) => a - b)[Math.floor(lat.length / 2)].toFixed(2)} s sim` : ''));
      say('');
      say(dz > 0.03
        ? '  The animals went UP when the floor flooded, beyond what they do anyway.'
        : '  NO escape above control. Either the fly does not respond to a hot floor, or the');
      if (dz <= 0.03) say('  escape command is computed and never read — the motor layer reads ~18 of 1,314');
      if (dz <= 0.03) say('  descending neurons, so those two possibilities are not distinguished here.');
    }
    colour = '#4ade80'; head = 'THERMAL ESCAPE — done'; paint();
    window.__thermalResults = out;
  } catch (e) { fail(e); }
})();

// Persistent defensive arousal — the corrected design.
//
// Anderson and Adolphs (2014) argue emotion can be studied without claiming any subjective
// feeling, by testing measurable properties instead: valence, persistence, scalability,
// generalisation. Gibson et al. (2015) applied that to Drosophila: repeated looming shadows
// produce a defensive arousal that outlasts the stimulus, grows with the number of sweeps,
// raises locomotion and suppresses feeding even in hungry flies.
//
// THE FIRST VERSION OF THIS FILE PRODUCED A NULL RESULT FROM AN INVALID DESIGN (FIELD-NOTES 25).
// Everything below marked [FIX] is there because of a specific way that run was wrong:
//
//   [FIX ORDER]    conditions ran 0,2,6 ascending on one fly, so the variable was confounded
//                  with time. Baselines climbed 0.422 -> 0.737 -> 1.495 cm/s, and normalising
//                  each condition to its own climbing baseline manufactured a downward trend.
//                  Order is now randomised per run.
//   [FIX N]        n = 1. Every fly is now an independent replicate: separate worker, separate
//                  brain seed, separate position, all seeing the same global looming object.
//   [FIX WASHOUT]  no recovery between conditions, so each began wherever the last one left off.
//                  There is now a washout period, and the baseline that follows it is reported
//                  so drift is visible rather than hidden.
//   [FIX BINS]     2 s bins sampled bout phase more than state. Walking and feeding are bouty;
//                  bins are longer now.
//   [FIX LOOM]     launchThreat() animates on WALL-CLOCK time — a ~350 ms swoop, which at 0.04x
//                  is 13 ms of the fly's own time. That was never a looming stimulus. The object
//                  is now stepped toward the fly over a span of SIMULATED milliseconds.
//
// The 0-pass control is the whole experiment. In the first run it produced the LARGEST effect,
// which is the only reason the result was thrown out instead of published.
//
//   arena.html?arousal=1&passes=0,3,8&flies=3

const A = window.__arena;

const box = document.createElement('div');
box.style.cssText = `position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:99999;
  background:#0b0f16;color:#e6edf3;border:2px solid #60a5fa;border-radius:12px;padding:20px 24px;
  font:12px/1.5 ui-monospace,Consolas,monospace;box-shadow:0 20px 60px rgba(0,0,0,.8);
  min-width:620px;max-height:88vh;overflow:auto;white-space:pre`;
document.body.appendChild(box);
let head = 'DEFENSIVE AROUSAL', lines = [], colour = '#60a5fa';
const paint = () => { box.style.borderColor = colour;
  box.innerHTML = `<div style="font-size:15px;font-weight:700;color:${colour};margin-bottom:10px">${head}</div>`
    + lines.map(l => `<div>${l}</div>`).join(''); };
const say = l => { lines.push(l); paint(); console.info('[arousal] ' + l); };
const fail = e => { colour = '#f87171'; head = 'ERROR'; say(''); say(String((e && e.stack) || e)); };
paint();
window.addEventListener('unhandledrejection', ev => fail(ev.reason));

const Q = new URLSearchParams(location.search);
const PASSES = (Q.get('passes') || '0,3,8').split(',').map(Number).filter(n => n >= 0);
const BASE_S = Number(Q.get('base')) || 3;      // simulated s of pre-stimulus baseline
const POST_S = Number(Q.get('post')) || 6;      // simulated s measured after the last pass
const BIN_S = Number(Q.get('bin')) || 3;        // [FIX BINS] wider than the original 2 s
const WASH_S = Number(Q.get('wash')) || 3;      // [FIX WASHOUT] recovery before each condition

const flies = () => A.flies;
const simS = () => (A.flies[0]?.last?.t || 0) / 1000;
const anyDead = () => A.flies.some(f => f.last && f.last.alive === false);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sync = () => { for (const f of A.flies) if (f.ready) f.worker.postMessage({ type: 'env', env: A.env }); };

/** Advance simulated time, with a wall-clock escape: a dead fly freezes the sim clock forever. */
async function advance(dt, maxWallMs = 600000) {
  const t0 = simS(), w0 = performance.now();
  while (simS() < t0 + dt) {
    if (anyDead() || performance.now() - w0 > maxWallMs) return false;
    await sleep(200);
  }
  return true;
}

/** Per-fly locomotion and feeding over a span of simulated time. [FIX N] every fly measured. */
async function measure(dt) {
  const t0 = simS(), w0 = performance.now();
  const st = flies().map(() => ({ last: null, dist: 0, n: 0, walk: 0, feed: 0 }));
  while (simS() < t0 + dt) {
    if (anyDead() || performance.now() - w0 > 600000) break;
    await sleep(120);
    flies().forEach((f, i) => {
      const s = f.last; if (!s) return; const q = st[i];
      if (q.last) q.dist += Math.hypot(s.pos[0] - q.last[0], s.pos[1] - q.last[1]);
      q.last = s.pos.slice(0, 2); q.n++;
      if (/walk|turn|run/i.test(s.behavior || '')) q.walk++;
      if (/feed|proboscis/i.test(s.behavior || '')) q.feed++;
    });
  }
  const el = Math.max(1e-3, simS() - t0);
  return st.map((q, i) => ({ fly: flies()[i]?.name ?? i, speed: +(q.dist / el).toFixed(3),
    walk: q.n ? +(q.walk / q.n).toFixed(3) : 0, feed: q.n ? +(q.feed / q.n).toFixed(3) : 0 }));
}

/**
 * [FIX LOOM] One looming pass in SIMULATED time, stepped toward the nearest fly's head.
 * Quadratic approach, so angular size accelerates toward contact — the expansion is the cue the
 * giant-fibre pathway detects (von Reyn et al. 2014), not mere proximity.
 */
async function loom({ ms = 260, from = 3.0, to = 0.35 } = {}) {
  const s0 = flies()[0]?.last; if (!s0) return false;
  const p = s0.pos, a = s0.yaw + 0.5;
  const t0 = simS(), dur = ms / 1000, w0 = performance.now();
  while (true) {
    const u = (simS() - t0) / dur;
    if (u >= 1 || anyDead() || performance.now() - w0 > 300000) break;
    const k = u * u, r = from + (to - from) * k;
    A.env.threat = { x: p[0] + r * Math.cos(a), y: p[1] + r * Math.sin(a), z: 0.45 + 1.15 * (1 - k) };
    for (const f of A.flies) if (f.ready) f.worker.postMessage({ type: 'env', env: { threat: A.env.threat } });
    await sleep(60);
  }
  A.env.threat = null;
  for (const f of A.flies) if (f.ready) f.worker.postMessage({ type: 'env', env: { threat: null } });
  return !anyDead();
}

async function condition(passes) {
  say('');
  say(`--- ${passes} pass${passes === 1 ? '' : 'es'} ---`);
  // hungry flies with food available, so feeding suppression is measurable at all
  A.env.food = [{ x: 0, y: 0, r: 1.8, sugar: 1, bitter: 0, water: 0.3, amount: 999 }];
  A.env.odors = [{ x: 0, y: 0, odor: 'vinegar', strength: 0.8, sigma: 3 }];
  A.env.hazards = []; A.env.bitterPatches = []; A.env.wind = [0, 0]; A.env.threat = null;
  A.rebuildEnv(); sync();

  // [FIX WASHOUT] let the previous condition wear off before this one's baseline is taken
  if (!await advance(WASH_S)) return null;
  const base = await measure(BASE_S);
  const bMean = base.reduce((s, r) => s + r.speed, 0) / base.length;
  say(`  baseline   speed ${base.map(r => r.speed.toFixed(2)).join(' ')}   mean ${bMean.toFixed(3)}`);
  if (anyDead()) { say('  a fly died — condition discarded'); return null; }

  for (let k = 0; k < passes; k++) {
    if (!await loom()) return null;
    if (!await advance(0.4)) return null;
  }
  if (passes === 0 && !await advance(1.0)) return null;

  const bins = [];
  for (let t = 0; t < POST_S; t += BIN_S) {
    const b = await measure(Math.min(BIN_S, POST_S - t));
    bins.push(b);
    const m = b.reduce((s, r) => s + r.speed, 0) / b.length;
    say(`  post +${(t + BIN_S).toFixed(0)}s   speed ${b.map(r => r.speed.toFixed(2)).join(' ')}   mean ${m.toFixed(3)}`
      + `   ratio ${(m / Math.max(1e-3, bMean)).toFixed(2)}`);
    if (anyDead()) break;
  }
  return { passes, base, bins, bMean };
}

(async () => {
  try {
    say(`flies ${flies().length} (independent replicates)   conditions [${PASSES.join(', ')}]`);
    say(`washout ${WASH_S}s, baseline ${BASE_S}s, post ${POST_S}s in ${BIN_S}s bins — all simulated time`);
    // [FIX ORDER] randomised, so condition is not confounded with elapsed time
    const order = [...PASSES].sort(() => Math.random() - 0.5);
    say(`order this run: ${order.join(' -> ')}   (randomised)`);
    say('');
    say('waiting for the mushroom-body warm-up (4 s sim)...');
    while (simS() < 5) { if (anyDead()) throw new Error('a fly died before the run started'); await sleep(500); }

    const out = [];
    for (const p of order) {
      const r = await condition(p);
      if (r) out.push(r);
      if (anyDead()) { say(''); say('a fly is dead; stopping.'); break; }
    }

    say('');
    say('=== post/baseline speed ratio, per condition ===');
    for (const r of out.sort((a, b) => a.passes - b.passes)) {
      const rel = r.bins.map(b => ((b.reduce((s, x) => s + x.speed, 0) / b.length) / Math.max(1e-3, r.bMean)).toFixed(2));
      say(`  ${String(r.passes).padStart(2)} passes   baseline ${r.bMean.toFixed(3)} cm/s   post ${rel.join('  ')}`);
    }
    const ctrl = out.find(r => r.passes === 0);
    say('');
    if (!ctrl) { say('NO 0-PASS CONTROL IN THIS RUN — nothing above is interpretable.'); }
    else {
      const bases = out.map(r => r.bMean), spread = (Math.max(...bases) - Math.min(...bases)) / Math.min(...bases);
      say(`baseline spread across conditions: ${(100 * spread).toFixed(0)}%`);
      say(spread > 0.5
        ? 'THAT IS TOO LARGE. The washout did not return the flies to a common state, so the'
        : 'Baselines are comparable, so the ratios above can be compared.');
      if (spread > 0.5) say('conditions are not comparable and this run should be discarded.');
      say('');
      say('A reflex gives post ~1.0 at every pass count. A persistent state gives post > 1.0,');
      say('decaying across the bins, and more of it with more passes — beyond what 0 passes does.');
    }
    colour = '#4ade80'; head = 'DEFENSIVE AROUSAL — done'; paint();
    window.__arousalResults = out;
  } catch (e) { fail(e); }
})();

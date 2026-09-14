// Persistent defensive arousal. Loaded by arena.html when ?arousal=1 is set.
//
// Asks whether a looming threat leaves the fly in a STATE rather than just provoking a reflex.
// Anderson and Adolphs (2014) argue that emotion can be studied in insects without claiming any
// subjective feeling, by testing for measurable properties instead: valence, persistence,
// scalability, generalisation. Gibson et al. (2015) applied that to Drosophila and found
// repeated looming shadows produce a defensive arousal that outlasts the stimulus by minutes,
// grows with the number of sweeps, raises locomotion, and suppresses feeding even in hungry flies.
//
// This runs that paradigm here. It deliberately does NOT depend on the mushroom body: defensive
// arousal is not associative learning, so it does not need the dopamine teaching signal that is
// currently too weak to gate plasticity (FIELD-NOTES section 21). It is a separate question and
// it can be asked now.
//
// The three predictions, in order of how much they would tell us:
//   1. PERSISTENCE   locomotion stays elevated after the threat is gone, decaying over seconds
//   2. SCALABILITY   more passes -> larger and/or longer-lasting elevation
//   3. GENERALISATION feeding is suppressed in a hungry fly, i.e. it leaks into other behaviour
//
// A reflex would give a spike during the threat and nothing after. A state gives 1-3.

const A = window.__arena;

const box = document.createElement('div');
box.style.cssText = `position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:99999;
  background:#0b0f16;color:#e6edf3;border:2px solid #60a5fa;border-radius:12px;padding:20px 24px;
  font:12px/1.5 ui-monospace,Consolas,monospace;box-shadow:0 20px 60px rgba(0,0,0,.8);
  min-width:560px;max-height:88vh;overflow:auto;white-space:pre`;
document.body.appendChild(box);
let head = 'PERSISTENT DEFENSIVE AROUSAL', lines = [], colour = '#60a5fa';
const paint = () => { box.style.borderColor = colour;
  box.innerHTML = `<div style="font-size:15px;font-weight:700;color:${colour};margin-bottom:10px">${head}</div>`
    + lines.map(l => `<div>${l}</div>`).join(''); };
const say = l => { lines.push(l); paint(); };
const fail = e => { colour = '#f87171'; head = 'ERROR'; say(''); say(String((e && e.stack) || e)); };
paint();
window.addEventListener('unhandledrejection', ev => fail(ev.reason));

const Q = new URLSearchParams(location.search);
const PASSES = (Q.get('passes') || '0,2,6').split(',').map(Number).filter(n => n >= 0);
const BASE_S = Number(Q.get('base')) || 3;      // simulated seconds of pre-threat baseline
const POST_S = Number(Q.get('post')) || 6;      // simulated seconds measured after the last pass
const BIN_S = Number(Q.get('bin')) || 2;        // post-period bin width, to show decay

const fly = () => A.flies[0];
const simS = () => (fly()?.last?.t || 0) / 1000;
const dead = () => { const s = fly()?.last; return !s || s.alive === false; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sync = () => { for (const f of A.flies) if (f.ready) f.worker.postMessage({ type: 'env', env: A.env }); };

/**
 * Advance a span of SIMULATED time.
 * Every wait carries a wall-clock escape as well. A dead fly stops stepping, so its sim clock
 * freezes -- a bare `while (simS() < target)` then spins forever. That hung an earlier harness
 * for seventeen minutes, so it is guarded here by construction.
 */
async function advance(dt, maxWallMs = 300000) {
  const t0 = simS(), w0 = performance.now();
  while (simS() < t0 + dt) {
    if (dead()) return false;
    if (performance.now() - w0 > maxWallMs) return false;
    await sleep(200);
  }
  return true;
}

/** Sample locomotion and feeding over a span of simulated time. */
async function measure(dt) {
  const t0 = simS(), w0 = performance.now();
  let last = null, lastT = null, dist = 0, n = 0, walking = 0, feeding = 0, pump = 0;
  while (simS() < t0 + dt) {
    if (dead() || performance.now() - w0 > 300000) break;
    await sleep(120);
    const s = fly()?.last; if (!s) continue;
    if (last && s.t > lastT) {
      dist += Math.hypot(s.pos[0] - last[0], s.pos[1] - last[1]);   // cm of path
    }
    last = s.pos.slice(0, 2); lastT = s.t;
    n++;
    if (/walk|turn|run/i.test(s.behavior || '')) walking++;
    if (/feed|proboscis/i.test(s.behavior || '')) feeding++;
    pump += s.feeding || 0;
    }
  const elapsed = Math.max(1e-3, simS() - t0);
  return {
    simS: +elapsed.toFixed(2),
    speed: +(dist / elapsed).toFixed(3),        // cm per simulated second
    walkFrac: n ? +(walking / n).toFixed(3) : 0,
    feedFrac: n ? +(feeding / n).toFixed(3) : 0,
    pump: n ? +(pump / n).toFixed(4) : 0,
    n,
  };
}

/** One looming pass, through the same channel a real predator would use. */
function loom() { A.launchThreat?.(); }

async function condition(passes) {
  say('');
  say(`--- ${passes} looming pass${passes === 1 ? '' : 'es'} ---`);

  // A hungry fly with food available, so feeding suppression is measurable at all.
  A.env.food = [{ x: 0, y: 0, r: 2.0, sugar: 1, bitter: 0, water: 0.3, amount: 999 }];
  A.env.odors = [{ x: 0, y: 0, odor: 'vinegar', strength: 0.8, sigma: 3 }];
  A.env.hazards = []; A.env.bitterPatches = []; A.env.wind = [0, 0]; A.env.threat = null;
  A.rebuildEnv(); sync();
  if (!await advance(1.5)) return null;

  const base = await measure(BASE_S);
  say(`  baseline    speed ${base.speed} cm/s   walk ${base.walkFrac}   feed ${base.feedFrac}`);
  if (dead()) { say('  fly died during baseline -- discarded'); return null; }

  // threat period
  for (let k = 0; k < passes; k++) { loom(); if (!await advance(1.0)) return null; }
  if (passes === 0) { if (!await advance(1.0)) return null; }

  // post period, binned so any decay is visible rather than averaged away
  const bins = [];
  for (let t = 0; t < POST_S; t += BIN_S) {
    const b = await measure(Math.min(BIN_S, POST_S - t));
    bins.push(b);
    say(`  post +${(t + b.simS).toFixed(1)}s  speed ${b.speed} cm/s   walk ${b.walkFrac}   feed ${b.feedFrac}`);
    if (dead()) { say('  fly died -- run truncated'); break; }
  }
  return { passes, base, bins, alive: !dead() };
}

(async () => {
  try {
    say(`flies ${A.flies.length}   conditions [${PASSES.join(', ')}] passes`);
    say(`baseline ${BASE_S}s sim, post ${POST_S}s sim in ${BIN_S}s bins`);
    say('');
    say('waiting for the mushroom-body warm-up to finish (4 s sim) so the brain is settled...');
    while (simS() < 5) { if (dead()) throw new Error('fly died before the run started'); await sleep(500); }

    const out = [];
    for (const p of PASSES) {
      const r = await condition(p);
      if (r) out.push(r);
      if (dead()) { say(''); say('fly is dead; stopping.'); break; }
    }

    say('');
    say('=== summary: speed relative to each condition\'s own baseline ===');
    for (const r of out) {
      const rel = r.bins.map(b => (r.base.speed > 1e-4 ? b.speed / r.base.speed : 0).toFixed(2));
      say(`  ${String(r.passes).padStart(2)} passes   base ${r.base.speed.toFixed(3)} cm/s   post ${rel.join('  ')}`);
    }
    say('');
    const zero = out.find(r => r.passes === 0);
    if (!zero) say('NOTE: no 0-pass control in this run, so none of the above is interpretable.');
    else say('Read against the 0-pass control: a reflex shows nothing after the threat;');
    say('a state shows post > 1.0 decaying over the bins, and more with more passes.');
    colour = '#4ade80'; head = 'PERSISTENT DEFENSIVE AROUSAL - done'; paint();
    window.__arousalResults = out;
    console.info('[arousal] results', out);
  } catch (e) { fail(e); }
})();

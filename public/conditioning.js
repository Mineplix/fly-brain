// Differential conditioning probe. Loaded by arena.html when ?cond=1 is set.
//
// Asks the only question that matters for "does the fly remember": after pairing ONE odour with
// punishment, is that odour's mushroom-body output selectively reduced, while a different odour's
// is not? A single-odour test cannot answer it -- global punishment teaches "something is wrong",
// which would depress everything the fly happened to smell.
//
// CS+ vinegar {DM1,DM4,VA2,DP1m,DM2,VM2,DL1}   CS- geosmin {DA2}
// These share no glomeruli, so they drive disjoint Kenyon-cell populations. (Banana would have
// been a poor control: it overlaps vinegar on 4 of its 7.)
//
// Learning is frozen during every measurement, so the probes read the memory rather than writing
// to it. Punishment is heat 0.5 -- exactly the damage threshold, so it drives the nociceptors at
// full strength without harming the fly. A dead fly stops stepping and its dopamine decays, which
// silently invalidated an earlier attempt at this.
const A = window.__arena;

const box = document.createElement('div');
box.style.cssText = `position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:99999;
  background:#0b0f16;color:#e6edf3;border:2px solid #4ade80;border-radius:12px;padding:20px 24px;
  font:13px/1.55 ui-monospace,Consolas,monospace;box-shadow:0 20px 60px rgba(0,0,0,.8);
  min-width:520px;max-height:88vh;overflow:auto;white-space:pre`;
document.body.appendChild(box);
let head = 'DIFFERENTIAL CONDITIONING', lines = [], colour = '#4ade80';
const paint = () => { box.style.borderColor = colour;
  box.innerHTML = `<div style="font-size:15px;font-weight:700;color:${colour};margin-bottom:10px">${head}</div>`
    + lines.map(l => `<div>${l}</div>`).join(''); };
const say = l => { lines.push(l); paint(); };
const fail = e => { colour = '#f87171'; head = 'ERROR'; say(''); say(String((e && e.stack) || e)); };
paint();
window.addEventListener('unhandledrejection', ev => fail(ev.reason));

const fly = () => A.flies[0];
const simT = () => fly().last?.t ?? 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sync = () => { for (const f of A.flies) if (f.ready) f.worker.postMessage({ type: 'env', env: A.env }); };
// ?learn=0 must survive the protocol. The training phase explicitly enables plasticity, which
// would otherwise re-enable it in the control and make the control identical to the test.
const LEARN_OK = new URLSearchParams(location.search).get('learn') !== '0';
const setLearn = on => fly().worker.postMessage({ type: 'learn', on: on && LEARN_OK });

/** Uniform odour across the whole arena, so the reading does not depend on where the fly wanders. */
function present(odor, heat) {
  A.env.odors = odor ? [{ x: 0, y: 0, odor, strength: 1, sigma: 5 }] : [];
  A.env.hazards = heat ? [{ x: 0, y: 0, r: 2.4, heat }] : [];
  A.env.food = []; A.env.bitterPatches = []; A.env.wind = [0, 0];
  A.rebuildEnv(); sync();
}

/** Advance a given amount of SIMULATED time, averaging MBON drive over the second half. */
async function phase(label, ms, { measure = false } = {}) {
  const start = simT(); let n = 0;
  const acc = { all: 0, exc: 0, inh: 0, aver: 0, appet: 0 };
  head = label; paint();
  while (simT() - start < ms) {
    await sleep(250);
    if (measure && simT() - start > ms * 0.4) {
      const m = fly().last?.mb;
      if (m) { acc.all += m.mbon; acc.exc += m.mExc; acc.inh += m.mInh; acc.aver += m.mAver; acc.appet += m.mAppet; n++; }
    }
    head = `${label}  (${((simT() - start) / 1000).toFixed(1)}/${(ms / 1000).toFixed(1)} sim s)`; paint();
  }
  if (!n) return null;
  const r = {}; for (const k in acc) r[k] = acc[k] / n;
  // The quantities that can actually express an association: the balance between MBON groups
  // with opposing valence, and between the punishment- and reward-taught compartments.
  r.excInh = r.inh > 0 ? r.exc / r.inh : 0;
  r.averAppet = r.appet > 0 ? r.aver / r.appet : 0;
  return r;
}

try {
  if (!A) throw new Error('arena not ready');
  const play = document.querySelector('#play');
  if (play && !play.textContent.includes('Pause')) play.click();

  say(LEARN_OK ? 'RUN: plasticity ON' : 'CONTROL: plasticity OFF throughout (?learn=0)');
  say('CS+ vinegar (punished)   CS- geosmin (safe)');
  say('learning frozen during all four probes');
  say('');

  present(null, 0);
  await phase('settling — dopamine baseline', 5000);

  setLearn(false);
  present('vinegar', 0); const preA = await phase('PRE-test  CS+ vinegar', 3000, { measure: true });
  present('geosmin', 0); const preB = await phase('PRE-test  CS- geosmin', 3000, { measure: true });
  const f2 = x => x.toFixed(2), f3 = x => x.toFixed(3);
  say(`pre  CS+  all ${f2(preA.all)}  exc/inh ${f3(preA.excInh)}  aver/appet ${f3(preA.averAppet)}`);
  say(`pre  CS-  all ${f2(preB.all)}  exc/inh ${f3(preB.excInh)}  aver/appet ${f3(preB.averAppet)}`);

  setLearn(true);
  present('vinegar', 0.5);
  await phase('TRAINING — CS+ paired with heat', 7000);
  const dep = fly().last?.mb?.depressed;
  setLearn(false);
  present(null, 0);
  await phase('rest', 2000);
  say(`trained: ${dep} synapses depressed`);
  say('');

  present('vinegar', 0); const postA = await phase('POST-test CS+ vinegar', 3000, { measure: true });
  present('geosmin', 0); const postB = await phase('POST-test CS- geosmin', 3000, { measure: true });

  say(`post CS+  all ${f2(postA.all)}  exc/inh ${f3(postA.excInh)}  aver/appet ${f3(postA.averAppet)}`);
  say(`post CS-  all ${f2(postB.all)}  exc/inh ${f3(postB.excInh)}  aver/appet ${f3(postB.averAppet)}`);
  say('');
  const pc = (a, b) => 100 * (b - a) / a;
  const rows = [['all', pc(preA.all, postA.all), pc(preB.all, postB.all)],
                ['excitatory', pc(preA.exc, postA.exc), pc(preB.exc, postB.exc)],
                ['inhibitory', pc(preA.inh, postA.inh), pc(preB.inh, postB.inh)],
                ['aversive cmpt', pc(preA.aver, postA.aver), pc(preB.aver, postB.aver)],
                ['appetitive cmpt', pc(preA.appet, postA.appet), pc(preB.appet, postB.appet)],
                ['exc/inh ratio', pc(preA.excInh, postA.excInh), pc(preB.excInh, postB.excInh)],
                ['aver/appet ratio', pc(preA.averAppet, postA.averAppet), pc(preB.averAppet, postB.averAppet)]];
  const sg = x => (x >= 0 ? '+' : '') + x.toFixed(1) + '%';
  say('readout            CS+(punished)   CS-(safe)   difference');
  for (const [nm, a, b] of rows) say(`${nm.padEnd(18)} ${sg(a).padStart(8)}  ${sg(b).padStart(10)}  ${sg(a - b).padStart(10)}`);
  say('');
  const dA = pc(preA.averAppet, postA.averAppet), dB = pc(preB.averAppet, postB.averAppet);
  const diff = dA - dB;
  const specific = Math.abs(diff) > 5;           // CS+ and CS- moved differently at all
  const aversive = diff < -5;                    // and in the direction aversive learning predicts
  colour = aversive ? '#4ade80' : (specific ? '#60a5fa' : '#fbbf24');
  const tag = LEARN_OK ? '' : ' [CONTROL, no plasticity]';
  head = (aversive ? 'ODOUR-SPECIFIC, aversive direction'
       : specific ? 'ODOUR-SPECIFIC, but opposite sign'
                  : 'NO SELECTIVITY') + tag;
  say(aversive ? 'CS+ shifted away from the aversive compartments, CS- did not.'
    : specific ? 'CS+ and CS- moved differently, so the change is odour specific -- but the punished odour drove the aversive compartments MORE, not less.'
               : 'CS+ and CS- moved together: general depression, not an association.');
  window.__cond = { preA, preB, postA, postB, rows, dep, specific, aversive, diff };
  paint();
} catch (e) { fail(e); }

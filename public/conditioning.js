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

// Every fly is an independent replicate: its brain seed is 101+id and its intrinsic seed id+1,
// so they differ in noise while sharing one environment. Running them together is also far
// cheaper than sequential runs -- per-fly rate falls but aggregate throughput rises, so four
// replicates cost about a quarter of what four separate runs would.
const fly = () => A.flies[0];
const simT = () => fly().last?.t ?? 0;
const alive = () => A.flies.filter(f => f.last && f.last.alive !== false);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sync = () => { for (const f of A.flies) if (f.ready) f.worker.postMessage({ type: 'env', env: A.env }); };
// ?learn=0 must survive the protocol. The training phase explicitly enables plasticity, which
// would otherwise re-enable it in the control and make the control identical to the test.
const LEARN_OK = new URLSearchParams(location.search).get('learn') !== '0';
const setLearn = on => { for (const f of A.flies) f.worker.postMessage({ type: 'learn', on: on && LEARN_OK }); };

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
  const acc = new Map();   // fly id -> running sums
  head = label; paint();
  while (simT() - start < ms) {
    await sleep(250);
    if (measure && simT() - start > ms * 0.4) {
      for (const f of A.flies) {
        const m = f.last?.mb; if (!m) continue;
        let a = acc.get(f.id); if (!a) { a = { all: 0, exc: 0, inh: 0, aver: 0, appet: 0, n: 0 }; acc.set(f.id, a); }
        a.all += m.mbon; a.exc += m.mExc; a.inh += m.mInh; a.aver += m.mAver; a.appet += m.mAppet; a.n++;
      }
      n++;
    }
    head = `${label}  (${((simT() - start) / 1000).toFixed(1)}/${(ms / 1000).toFixed(1)} sim s)`; paint();
  }
  if (!n) return null;
  const out = new Map();
  for (const [id, a] of acc) {
    if (!a.n) continue;
    const r = { all: a.all / a.n, exc: a.exc / a.n, inh: a.inh / a.n, aver: a.aver / a.n, appet: a.appet / a.n };
    r.excInh = r.inh > 0 ? r.exc / r.inh : 0;
    r.averAppet = r.appet > 0 ? r.aver / r.appet : 0;
    out.set(id, r);
  }
  return out;
}

const KEYS = ['all', 'exc', 'inh', 'aver', 'appet', 'excInh', 'averAppet'];
const LABEL = { all: 'all', exc: 'excitatory', inh: 'inhibitory', aver: 'aversive cmpt',
                appet: 'appetitive cmpt', excInh: 'exc/inh ratio', averAppet: 'aver/appet ratio' };
const mean = v => v.reduce((s, x) => s + x, 0) / v.length;
const sd = v => { if (v.length < 2) return 0; const m = mean(v); return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1)); };
const sg = x => (x >= 0 ? '+' : '') + x.toFixed(1);

try {
  if (!A) throw new Error('arena not ready');
  const play = document.querySelector('#play');
  if (play && !play.textContent.includes('Pause')) play.click();

  while (A.flies.length < A.FLY_CAP) await A.addFly([Math.random() * 2 - 1, Math.random() * 2 - 1], Math.random() * 6.28);
  const N = A.flies.length;

  say(LEARN_OK ? 'RUN: plasticity ON' : 'CONTROL: plasticity OFF (?learn=0)');
  say(`${N} flies = ${N} independent replicates (seeds differ by fly id)`);
  say('CS+ vinegar (punished)   CS- geosmin (safe)');
  say('');

  present(null, 0);
  await phase('settling — dopamine baseline', 4000);

  setLearn(false);
  present('vinegar', 0); const preA = await phase('PRE  CS+ vinegar', 2500, { measure: true });
  present('geosmin', 0); const preB = await phase('PRE  CS- geosmin', 2500, { measure: true });

  setLearn(true);
  present('vinegar', 0.5);
  await phase('TRAINING — CS+ paired with heat', 6000);
  const dep = A.flies.map(f => f.last?.mb?.depressed ?? 0);
  setLearn(false);
  present(null, 0);
  await phase('rest', 1500);
  say(`depressed per fly: ${dep.join(', ')}`);
  say('');

  present('vinegar', 0); const postA = await phase('POST CS+ vinegar', 2500, { measure: true });
  present('geosmin', 0); const postB = await phase('POST CS- geosmin', 2500, { measure: true });

  // Per fly: how much CS+ moved minus how much CS- moved. One number per replicate per readout.
  const pc = (a, b) => (a > 0 ? 100 * (b - a) / a : 0);
  const per = {}; for (const k of KEYS) per[k] = [];
  const ids = [...preA.keys()].filter(id => postA.has(id) && preB.has(id) && postB.has(id));
  for (const id of ids) for (const k of KEYS) {
    per[k].push(pc(preA.get(id)[k], postA.get(id)[k]) - pc(preB.get(id)[k], postB.get(id)[k]));
  }

  say(`readout            CS+ minus CS-, per fly        mean +/- sd`);
  const summary = {};
  for (const k of KEYS) {
    const v = per[k], m = mean(v), s = sd(v);
    summary[k] = { values: v.map(x => +x.toFixed(1)), mean: +m.toFixed(1), sd: +s.toFixed(1) };
    say(`${LABEL[k].padEnd(18)} ${v.map(x => sg(x).padStart(7)).join('')}   ${sg(m).padStart(7)} +/-${s.toFixed(1).padStart(5)}`);
  }
  say('');
  const a = summary.aversive || summary.aver, p = summary.appet;
  const clear = Math.abs(a.mean) > 2 * a.sd && a.sd > 0;
  colour = clear ? '#60a5fa' : '#fbbf24';
  head = (clear ? 'EFFECT EXCEEDS SPREAD' : 'EFFECT WITHIN SPREAD') + (LEARN_OK ? '' : ' [CONTROL]');
  say(clear
    ? `aversive compartments: ${sg(a.mean)} +/- ${a.sd.toFixed(1)}, larger than the run-to-run spread.`
    : `aversive compartments: ${sg(a.mean)} +/- ${a.sd.toFixed(1)} -- not separable from noise at n=${ids.length}.`);
  window.__cond = { n: ids.length, learn: LEARN_OK, dep, summary };
  paint();
} catch (e) { fail(e); }

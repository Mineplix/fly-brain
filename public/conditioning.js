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
const setLearn = on => fly().worker.postMessage({ type: 'learn', on });

/** Uniform odour across the whole arena, so the reading does not depend on where the fly wanders. */
function present(odor, heat) {
  A.env.odors = odor ? [{ x: 0, y: 0, odor, strength: 1, sigma: 5 }] : [];
  A.env.hazards = heat ? [{ x: 0, y: 0, r: 2.4, heat }] : [];
  A.env.food = []; A.env.bitterPatches = []; A.env.wind = [0, 0];
  A.rebuildEnv(); sync();
}

/** Advance a given amount of SIMULATED time, averaging MBON drive over the second half. */
async function phase(label, ms, { measure = false } = {}) {
  const start = simT(); let sum = 0, n = 0;
  head = label; paint();
  while (simT() - start < ms) {
    await sleep(250);
    if (measure && simT() - start > ms * 0.4) { const v = fly().last?.mb?.mbon; if (v != null) { sum += v; n++; } }
    head = `${label}  (${((simT() - start) / 1000).toFixed(1)}/${(ms / 1000).toFixed(1)} sim s)`; paint();
  }
  return n ? sum / n : null;
}

try {
  if (!A) throw new Error('arena not ready');
  const play = document.querySelector('#play');
  if (play && !play.textContent.includes('Pause')) play.click();

  say('CS+ vinegar (punished)   CS- geosmin (safe)');
  say('learning frozen during all four probes');
  say('');

  present(null, 0);
  await phase('settling — dopamine baseline', 5000);

  setLearn(false);
  present('vinegar', 0); const preA = await phase('PRE-test  CS+ vinegar', 3000, { measure: true });
  present('geosmin', 0); const preB = await phase('PRE-test  CS- geosmin', 3000, { measure: true });
  say(`pre   CS+ ${preA.toFixed(2)}   CS- ${preB.toFixed(2)}`);

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

  const dA = 100 * (postA - preA) / preA, dB = 100 * (postB - preB) / preB;
  say(`post  CS+ ${postA.toFixed(2)}   CS- ${postB.toFixed(2)}`);
  say('');
  say(`CS+ change  ${dA >= 0 ? '+' : ''}${dA.toFixed(1)}%   <- punished odour`);
  say(`CS- change  ${dB >= 0 ? '+' : ''}${dB.toFixed(1)}%   <- safe odour`);
  say('');
  const selective = dA < dB - 3;
  colour = selective ? '#4ade80' : '#fbbf24';
  head = selective ? 'SELECTIVE: the punished odour lost more' : 'NOT SELECTIVE — see note';
  say(selective
    ? 'The memory is odour specific.'
    : 'Both odours moved together: this is general depression, not an association.');
  window.__cond = { preA, preB, postA, postB, dA, dB, dep, selective };
  paint();
} catch (e) { fail(e); }

// The righting reflex on its own: MuJoCo in node, no brain, no browser.
//
//   node bench/righting-rig.mjs [trialsPerArm]     default 20
//
// WHY THE PHYSICS ALONE, AND NOT THE WHOLE ANIMAL IN A PAGE.
//
// Running the fly in the browser means writing the 165k-neuron connectome into a SharedArrayBuffer,
// about 1.5 GB, before a single trial. On a machine without that much free it does not merely run
// slowly, it does not run: several attempts stalled at exactly that step and produced no trials.
//
// But the righting reflex is not a brain behaviour. Motor.apply() decides it from `extra.up` and
// `extra.roll`, both read straight off the MuJoCo body frame, and writes leg and wing actuators
// directly. The descending population contributes nothing to it. So the reflex can be exercised
// with the physics alone, and with every brain rate at zero the muscles are silent and the reflex
// is the ONLY thing driving the animal -- a cleaner preparation than the page, not merely a cheaper
// one. Nothing here can be confounded by what the connectome happened to be doing.
//
// WHAT IT CANNOT TELL YOU, and this bounds every number it produces: an animal whose reflex works
// here might still fail with the descending drive acting on the same actuators. This measures the
// reflex, not the animal.
//
// The arms are written out in full in ARM_DEF rather than read from the RIGHT defaults, so that
// changing a default can never silently redefine a control arm.
import loadMujoco from '@mujoco/mujoco';
import { readFileSync } from 'node:fs';
import { Motor, RIGHT } from '../src/sim/motor.js';
import { buildWorldXML } from '../src/sim/world.js';

const PER_ARM = Math.max(2, Math.min(200, Number(process.argv[2]) || 20));
const P = 'public/';
const flyXML = readFileSync(P + 'body/fly_physics.xml', 'utf8');
const bodymap = JSON.parse(readFileSync(P + 'data/bodymap.json', 'utf8'));
const gait = JSON.parse(readFileSync(P + 'body/gait.json', 'utf8'));

// THE NEURON ARRAYS ARE STUBS, AND THEY MUST STILL BE LONG ENOUGH.
//
// Motor keeps `this.rate` at typeOf.length and every muscle reads rate[i] for its own neuron
// indices. A zero-length array makes those reads `undefined`, `mean()` returns NaN, and every
// actuator is set to NaN -- physics then produces garbage that looks like a failed righting.
// Sizing from the largest index the bodymap actually references keeps the rates at a real zero.
let maxIdx = 0;
for (const m of bodymap.muscles) for (const i of m.idx) if (i > maxIdx) maxIdx = i;
for (const i of [...(bodymap.jump || []), ...(bodymap.feeding || [])]) if (i > maxIdx) maxIdx = i;
const N = maxIdx + 1;
const typeOf = new Array(N).fill(null);     // no DN types -> every descending population is empty
const sideOf = new Int8Array(N);

const env = { arena: { shape: 'circle', radius: 2.0, wallHeight: 0.9, segments: 24 },
              food: [], odors: [], hazards: [], bitterPatches: [], obstacles: [],
              wind: [0, 0], light: { sky: 1 } };

const mj = await loadMujoco();

/** One flip. Returns how it went. */
// Arms are written out in full rather than read from the RIGHT defaults, so that changing a default
// can never silently redefine a control arm. `side` and `release` are kept as names because
// motor.js and FIELD-NOTES cite runs made under them.
const ARM_DEF = {
  ships:   { off: 0, mirror: 1, commitGrip: 0 },   // the current default, since 2026-09-18
  grip:    { off: 0, mirror: 1, commitGrip: 1 },   // grip held through commit: the default before it
  fixed:   { off: 0, mirror: 0, commitGrip: 1 },   // the original fixed-left reflex
  off:     { off: 1, mirror: 1, commitGrip: 0 },   // no reflex at all: the floor
};
ARM_DEF.side = ARM_DEF.grip;         // what `side` meant in the 2026-09-18 runs
ARM_DEF.release = ARM_DEF.ships;     // and what `release` meant

function trial(armName, seed) {
  Object.assign(RIGHT, ARM_DEF[armName]);
  const model = mj.MjModel.from_xml_string(buildWorldXML(flyXML, env, { flyPos: [0, 0, 0.132], flyYaw: 0 }));
  const d = new mj.MjData(model);
  const motor = new Motor(mj, model, d, bodymap, typeOf, sideOf, gait, 'descending', {});
  const bid = model.body('thorax').id;
  const free = model.jnt_qposadr[model.body('thorax').jntadr ?? 0];

  // SUPINE, WITH A DIFFERENT NUDGE EACH TRIAL. Deterministic physics from one identical start
  // gives one identical answer, so twenty trials of the same drop would be one trial reported
  // twenty times. The nudge is a small random roll offset and angular velocity, which is what
  // makes the animal settle onto one flank or the other -- the very thing the side selection is
  // supposed to react to.
  const rnd = (() => { let s = seed * 2654435761 % 2147483647; return () => (s = s * 16807 % 2147483647) / 2147483647; })();
  const tilt = (rnd() - 0.5) * 1.2;                       // radians of extra roll about the body x axis
  const half = Math.PI / 2 + tilt / 2;
  d.qpos[free + 2] = 0.30;
  d.qpos[free + 3] = Math.cos(half); d.qpos[free + 4] = Math.sin(half);   // ~180 deg about x: supine
  d.qpos[free + 5] = 0; d.qpos[free + 6] = 0;
  for (let i = 0; i < d.qvel.length; i++) d.qvel[i] = 0;
  d.qvel[3] = (rnd() - 0.5) * 6;                          // a little roll rate, so it tips one way
  mj.mj_forward(model, d);

  const perMs = Math.round(0.001 / model.opt.timestep);
  let t = 0, maxUp = -1, righted = false, tRight = null;
  let everInverted = false, roll0 = null, pushed0 = null, tOnset = null;
  // 3 s, not 6. Every success in the 20-trial run landed between 171 and 213 ms, so the extra
  // three seconds were spent watching animals that had already failed -- at a real cost, since a
  // failed trial runs the window to the end and that is most of them.
  while (t < 3000) {
    const up = d.xmat[bid * 9 + 8], roll = d.xmat[bid * 9 + 7];
    motor.apply(t, 1, { up, roll, touching: true });
    // THE ROLL THAT MATTERS IS THE ONE AT ONSET. Averaging it over the first 400 ms compares the
    // two arms on a quantity they have already changed -- the reflex is driving by then, and the
    // same drop gave -0.837 in one arm and 0.016 in the other. Sampled when the reflex first
    // engages, it is a property of the landing, which is what both arms genuinely share.
    if (motor.righting && roll0 === null) { roll0 = roll; pushed0 = motor.pushSide; tOnset = t; }
    for (let s = 0; s < perMs; s++) mj.mj_step(model, d);
    t += 1;
    const upAfter = d.xmat[bid * 9 + 8];
    if (upAfter < -0.3) everInverted = true;
    if (upAfter > maxUp) maxUp = upAfter;
    // A TRIAL ONLY COUNTS ONCE THE ANIMAL HAS ACTUALLY BEEN INVERTED. Some drops flop upright on
    // landing without the reflex ever engaging; scored naively those came out "righted" in BOTH
    // arms at t = 401 ms with the push side still unset, which is a drop being credited to a
    // reflex that never ran.
    if (everInverted && upAfter > 0.8) { righted = true; tRight = t; break; }
  }
  d.delete?.(); model.delete?.();
  return { arm: armName, roll: roll0 === null ? null : +roll0.toFixed(3), righted, tRight,
           maxUp: +maxUp.toFixed(3), pushed: pushed0, everInverted, tOnset };
}

console.log(`${PER_ARM} flips per arm, physics only, brain rates all zero\n`);
console.log('  trial  arm            roll   lying on   pushed   righted   max up   t(ms)');
// Which arms to run: `node bench/righting-rig.mjs 8 side,release`. Defaults to all four.
const ARMS = (process.argv[3] || 'ships,grip,fixed,off').split(',').filter(a => ARM_DEF[a]);
const LABEL = { ships: 'ships/no grip', grip: 'grip held', fixed: 'fixed-left',
                off: 'REFLEX OFF', side: 'grip held', release: 'ships/no grip' };
const rows = [];
for (let sd = 1; sd <= PER_ARM; sd++) {
  // All three arms see the IDENTICAL drop, so any difference between them is the reflex and
  // nothing else. Paired rather than merely counterbalanced.
  for (const a of ARMS) {
    const r = trial(a, sd);
    r.seed = sd;
    r.side = r.roll === null ? 'n/a' : r.roll > 0.15 ? 'RIGHT' : r.roll < -0.15 ? 'left' : 'flat';
    rows.push(r);
    console.log('  ' + String(rows.length).padStart(5) + '  ' + LABEL[a].padEnd(14) +
      (r.roll === null ? '  --  ' : r.roll.toFixed(3).padStart(6)) + '   ' + r.side.padEnd(6) + '   ' +
      String(r.pushed || '-').padEnd(6) + '   ' + (r.righted ? 'yes' : 'no ').padStart(7) + '   ' +
      r.maxUp.toFixed(3).padStart(6) + '   ' + String(r.tRight ?? '').padStart(5));
  }
}

const arm = a => rows.filter(r => r.arm === a);
const n = rs => rs.filter(r => r.righted).length;
const avg = rs => rs.length ? (rs.reduce((a, b) => a + b.maxUp, 0) / rs.length).toFixed(3) : '--';
console.log('\n---- righted within 3 s ---------------------------------------------------');
for (const a of ARMS)
  console.log('  ' + LABEL[a].padEnd(16) + (n(arm(a)) + '/' + arm(a).length).padStart(7) +
              '   mean max up ' + avg(arm(a)));

console.log('\n---- split by which flank it landed on -------------------------------------');
console.log('  ' + 'arm'.padEnd(16) + 'roll > 0 (left flank up)   roll < 0 (right flank up)');
for (const a of ARMS) {
  const hi = arm(a).filter(r => r.roll > 0.15), lo = arm(a).filter(r => r.roll < -0.15);
  console.log('  ' + LABEL[a].padEnd(16) +
    (n(hi) + '/' + hi.length + '  max up ' + avg(hi)).padEnd(27) +
    (n(lo) + '/' + lo.length + '  max up ' + avg(lo)));
}

console.log('\n---- paired, per drop ------------------------------------------------------');
const pair = (x, y) => {
  let onlyX = 0, onlyY = 0, both = 0, neither = 0;
  for (let sd = 1; sd <= PER_ARM; sd++) {
    const a = rows.find(r => r.seed === sd && r.arm === x), b = rows.find(r => r.seed === sd && r.arm === y);
    if (!a || !b) continue;
    if (a.righted && b.righted) both++; else if (a.righted) onlyX++; else if (b.righted) onlyY++; else neither++;
  }
  const disc = onlyX + onlyY;
  let p = 1;
  if (disc) {
    const C = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; };
    p = 0; for (let k = Math.min(onlyX, onlyY); k >= 0; k--) p += C(disc, k) * Math.pow(0.5, disc);
    p = Math.min(1, 2 * p);
  }
  console.log('  ' + (LABEL[x] + ' vs ' + LABEL[y]).padEnd(32) +
    'only ' + LABEL[x] + ': ' + onlyX + ',  only ' + LABEL[y] + ': ' + onlyY +
    ',  both: ' + both + ',  neither: ' + neither +
    (disc ? '   exact McNemar p = ' + p.toFixed(3) : '   no discordant pairs'));
};
for (let i = 0; i < ARMS.length; i++) for (let j = i + 1; j < ARMS.length; j++) pair(ARMS[i], ARMS[j]);

console.log('\n---- did the mechanism engage ---------------------------------------------');
for (const a of ARMS) {
  const rs = arm(a);
  console.log('  ' + LABEL[a].padEnd(16) +
    'engaged ' + (rs.filter(r => r.pushed).length + '/' + rs.length).padStart(6) +
    '   pushed RIGHT ' + (rs.filter(r => r.pushed === 'right').length + '/' + rs.length).padStart(6) +
    (a === 'off' ? '   (both must be 0)' : a === 'fixed' ? '   (RIGHT must be 0)' : ''));
}
const wrong = rows.filter(r => ARM_DEF[r.arm].mirror === 1).filter(r => r.pushed && r.side !== 'flat' &&
  ((r.roll > 0.15 && r.pushed !== 'left') || (r.roll < -0.15 && r.pushed !== 'right'))).length;
console.log('  side-picking arms pushing against the roll: ' + wrong + '   (must be 0)');

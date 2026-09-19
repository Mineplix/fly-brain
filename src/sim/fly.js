// FlyAgent: one connectome brain in one physically simulated body, living in an arena.
// Closed loop every 1 ms of simulated time:
//   physics state -> Senses (+ CompoundEye every 10 ms) -> sensory neuron drive -> brain (2 x 0.5 ms LIF steps)
//   -> Motor (descending commands / motor neurons) -> actuators -> physics (10 x 0.1 ms MuJoCo steps)
import { buildWorldXML } from './world.js';
import { Senses, CompoundEye, clearance, heatAt } from './senses.js';
import { Intrinsic } from './intrinsic.js';
import { Neuromod } from './neuromod.js';
import { Flight } from './flight.js';
import { FlyVisionFV } from './vision.js';
import { Motor } from './motor.js';
import { MushroomBody } from './mushroom.js';
import { createBrain } from '../brainmodel.js';

// Injury thresholds. `BURN.floor` sits below the 0.5 hazard value because heat at the tarsi is
// the full substrate value only when the foot is on the floor; a fly on a crate should not burn.
// `floor` is where tissue damage begins, and damage is PROPORTIONAL to how far above it the
// substrate is -- not a step. The step version was a cliff with about a millimetre of margin:
// heat at the tarsi is 0.5 * exp(-z / 0.28), so against a threshold of 0.35 an animal burned only
// while its feet were below 0.28 * ln(0.5/0.35) = 0.0999 cm, and its thorax stands at 0.132. A
// tarsus at 0.100 cm took nothing while one at 0.099 took the full rate, so damage flickered on
// and off with the swing phase of a leg and stopped entirely if the animal stood tall. That made
// injury a function of posture rather than of temperature. This is the same fault as the original
// thorax-height bug, where the threshold was unreachable and nothing could ever be burned; moving
// the measurement to the tarsi made it reachable but left almost no margin.
// rate 1.6 killed a fly in 3.1 s of full tarsal contact -- max heat 0.5 less floor 0.30 is 0.2, so
// 1.6 * 0.2 = 0.32 health/s. The escape reflex cannot fire before 1700 ms (motor.js refuses all
// jumps inside a 1500 ms startup window), which left barely a second to act and turned an escape
// experiment into a survival-time one: a fresh animal died at 3182 ms without leaving the floor.
// At 0.9 an animal that never escapes still dies, in about 5.5 s, with room for the reflex to run.
const BURN = { floor: 0.30, rate: 0.9 };
// A strike is proximity-based: the monster geom does not collide, by design.
const BITE = { reach: 0.42, rate: 0.9 };

const Rt9 = (xm, b) => [xm[b * 9], xm[b * 9 + 3], xm[b * 9 + 6]];   // body x axis (heading) in world frame

// ---- PHASE TIMING ----------------------------------------------------------------------------
// `PROF.on` is null unless someone is measuring, so a normal run pays one null check per phase.
// This times the REAL step in place. The `profile` message in the worker re-implements an
// abbreviated step instead, which is why it reported 2.0 ms per simulated ms while the live loop
// was spending 28 -- it was timing a different, smaller thing and calling it the step.
export const PROF = { on: null };
export const PHASES = ['state', 'senses', 'vision', 'driveClear', 'intrinsic', 'driveSet',
                       'brain', 'readBrain', 'motor', 'physics', 'mushroom', 'physiology'];
export function profStart() {
  const o = { steps: 0, t0: performance.now(), nRates: 0, nEye: 0, nChanged: 0, nOverlap: 0, nSamp: 0 };
  for (const k of PHASES) o[k] = 0;
  PROF.on = o; return o;
}
export function profStop() { const o = PROF.on; PROF.on = null; return o; }

export class FlyAgent {
  constructor({ mj, flyXML, env, data, size, sign, bodymap, gait, id = 0, pos = [0, 0], yaw = 0, nProxies = 0, mode = 'descending', brainOpts = {}, vision = true, brain = null, flyvis = null, intrinsic = true, seed = 0, neuromod = null, sex = 'm', look = null, mushroom = null, learn = true, etaMul = 1, mbParams = null, noci = false, dnAll = false }) {
    this.id = id; this.mj = mj; this.env = env; this.data = data; this.vision = vision; this.sex = sex;
    // Reflectance of the checker floor and striped wall, matching whatever the host is drawing.
    // Defaults are the original muted arena; the circus theme is far higher contrast.
    this.look = look || { floorLo: 0.35, floorHi: 0.60, wallLo: 0.15, wallHi: 0.75 };
    this.model = mj.MjModel.from_xml_string(buildWorldXML(flyXML, env, { flyPos: [pos[0], pos[1], 0.132], flyYaw: yaw, nProxies }));
    this.mjd = new mj.MjData(this.model);
    this.physPerMs = Math.round(0.001 / this.model.opt.timestep);
    mj.mj_forward(this.model, this.mjd);
    const M = this.model, name2body = n => M.body(n).id;
    this.bid = { thorax: name2body('thorax'), head: name2body('head'), labrum: name2body('labrum_left'), antL: name2body('antenna_left'), antR: name2body('antenna_right') };
    this.claw = {}; for (const l of ['T1', 'T2', 'T3']) for (const s of ['left', 'right']) this.claw[`${l}_${s}`] = name2body(`claw_${l}_${s}`);
    this.sensorAdr = {}; for (let i = 0; i < M.nsensor; i++) this.sensorAdr[M.sensor(i).name] = M.sensor_adr[i];
    this.jointAdr = {}; for (let j = 0; j < M.njnt; j++) this.jointAdr[M.jnt(j).name] = M.jnt_qposadr[j];
    // geoms: albedo for vision; which bodies count as "self body" for bristle contact
    this.geomKind = []; for (let g = 0; g < M.ngeom; g++) { const n = M.geom(g).name; this.geomKind.push(n === 'floor' ? 'floor' : n.startsWith('wall') ? 'wall' : n.startsWith('food') ? 'food' : n.startsWith('bitter') ? 'bitter' : n.startsWith('hazard') ? 'hazard' : n.startsWith('obst') ? 'obst' : n.startsWith('proxy') ? 'fly' : n.startsWith('threat') ? 'threat' : n.startsWith('monster') ? 'monster' : 'self'); }
    this.floorGeom = M.geom('floor').id;
    this.threatMocap = M.body_mocapid[M.body('threat').id];
    this.monsterMocap = M.body_mocapid[M.body('monster').id];
    // brain
    this.brain = brain || createBrain(data, size, brainOpts, sign);   // wasm brain can be injected (shared connectome memory)
    // hunger as hormones and octopamine (neuromod: { calib: neuromod.json, block }); needs brainOpts.neuromod, which
    // also removes the OA neurons' fast synapses from the graph
    this.neuromod = brainOpts.neuromod ? new Neuromod(data, this.brain, { calib: neuromod?.calib, block: neuromod?.block, params: neuromod?.params, minSyn: brainOpts.minSyn ?? 5 }) : null;
    const typeOf = data.meta.types, sideOf = data.side;
    this.senses = new Senses(bodymap, mj, M); this.senses.bindTypes(typeOf, sideOf);
    this.vpFix = this.senses.vpFix;   // VP1m/VP1l correction, reported so it can be checked
    if (this.id === 0 && this.vpFix) console.info(`[senses] VP correction: ${this.vpFix.toHygro} VP1m -> hygrosensory, ${this.vpFix.toThermo} VP1l -> thermosensory`);
    if (noci) {
      const n = this.senses.bindNociceptors(typeOf, data.cls, data.superclass, data.meta);
      if (this.id === 0) console.info(`nociceptive afferents enabled: ${n.ppl} PPL neurons (valence), ${n.vnc} VNC afferents (reflex)`);
      if (this.id === 0 && !n.vnc) console.warn('[senses] VNC nociceptive branch is EMPTY — reflex arc inactive, only the valence branch is wired');
      this.nociCounts = n;   // reported through the worker's ready message so a harness can verify it
    }
    // LC10 small-object visual projection neurons: the eye-to-courtship channel. A nearby fly is detected
    // visually (LC10 responds to small moving objects; LC10a -> pC1/pIP10, Ribeiro et al. 2018), which is
    // how a male starts courting before the cVA pheromone plume reaches him
    this.lc10 = { left: [], right: [] };
    for (let i = 0; i < typeOf.length; i++) if (/^LC10[ad]$/.test(typeOf[i])) this.lc10[sideOf[i] === 2 ? 'right' : 'left'].push(i);
    // vision: flyvis optic-lobe model driving the male-CNS optic lobe (if provided), else the simple photoreceptor eye
    this.fv = vision && flyvis ? new FlyVisionFV(mj, M, this.mjd, bodymap, flyvis.map, flyvis.eyes, this.bid.head, this.bid.thorax, flyvis.gain ?? 150) : null;
    this.eye = vision && !this.fv ? new CompoundEye(mj, M, this.mjd, bodymap, this.bid.head, this.bid.thorax) : null;
    this.motor = new Motor(mj, M, this.mjd, bodymap, typeOf, sideOf, gait, mode,
      { dnAll, superclass: data.superclass, superclassNames: data.meta?.superclasses });
    this.intrinsic = intrinsic ? new Intrinsic(typeOf, sideOf, id + 1 + (seed || 0), bodymap.feeding) : null;
    this.flight = new Flight({ mj, model: M, data: this.mjd, thorax: this.bid.thorax, jointAdr: this.jointAdr, act: this.motor.act, range: this.motor.range, rand: this.intrinsic?.rand });
    // Per-fly associative memory over the KC->MBON slice. Private to this animal; the shared
    // connectome is never written. Stage 1: allocated and stepped, but learns nothing yet.
    this.mb = mushroom ? new MushroomBody(mushroom, this.brain, { learn, etaMul, ...(mbParams || {}) }) : null;
    this.flights = 0;
    this.driven = new Int32Array(0);
    // physiology
    this.energy = 0.6; this.health = 1; this.alive = true; this.eaten = 0; this.t = 0; this.foodEaten = env.food.map(() => 0); this.dist = 0; this.jumps = 0; this._lastPos = null; this._wasJumping = false;
    this.others = [];   // [{x,y,yaw}] of other flies (set by the host)
    this.log = [];
    this.takeoffPending = false;
  }
  requestTakeoff() { if (this.alive && !this.flight.active) this.takeoffPending = true; }
  state() {
    const d = this.mjd, xp = d.xpos, B = this.bid;
    const P = b => [xp[3 * b], xp[3 * b + 1], xp[3 * b + 2]];
    const sd = this.mjd.sensordata, sa = this.sensorAdr;
    const st = { pos: P(B.thorax), labellum: P(B.labrum), antenna: { left: P(B.antL), right: P(B.antR) }, claw: {}, touch: {}, load: {}, joint: {},
      gyro: [sd[sa.gyro], sd[sa.gyro + 1], sd[sa.gyro + 2]], vel: [sd[sa.velocimeter], sd[sa.velocimeter + 1], sd[sa.velocimeter + 2]],
      bodyContact: { left: false, right: false }, otherFlies: this.others, sugarGain: 0.6 + 0.9 * (1 - this.energy), bitterGain: 0.6 + 0.8 * this.energy };
    st.labellumZ = st.labellum[2];
    st.pitchUp = d.xmat[B.thorax * 9 + 6];   // sine of nose-up pitch (body x axis z component)
    st.proboscisOut = this.motor.proboscisOut(); st.stepping = this.motor.stepAmp || 0;
    for (const [k, b] of Object.entries(this.claw)) { st.claw[k] = P(b); st.touch[k] = sd[sa[`touch_claw_${k}`]]; const f = sa[`force_tarsus_${k}`]; st.load[k] = Math.hypot(sd[f], sd[f + 1], sd[f + 2]); }
    for (const [n, a] of Object.entries(this.jointAdr)) if (/^(tibia|coxa)_T/.test(n)) st.joint[n] = d.qpos[a];
    // body contacts with anything other than the floor (walls, obstacles, other flies) -> bristles by side (every 10 ms)
    if (this.t % 10 === 0) {
      const Rt = d.xmat.slice(B.thorax * 9, B.thorax * 9 + 9); const bc = { left: false, right: false };
      const cv = d.contact; const n = Math.min(d.ncon, cv.size());
      for (let c = 0; c < n; c++) { const con = cv.get(c); const k1 = this.geomKind[con.geom1], k2 = this.geomKind[con.geom2];
        if ((k1 === 'self') !== (k2 === 'self') && k1 !== 'floor' && k2 !== 'floor') {
          const p = con.pos; const rel = [p[0] - st.pos[0], p[1] - st.pos[1], p[2] - st.pos[2]]; const lat = Rt[1] * rel[0] + Rt[4] * rel[1] + Rt[7] * rel[2];
          bc[lat > 0 ? 'left' : 'right'] = true; }
        con.delete(); }
      cv.delete(); this._bodyContact = bc;
    }
    st.bodyContact = this._bodyContact || st.bodyContact;
    // obstacle ahead: antenna tips (~0.2 mm in front of the antenna bases) or a front claw reach a wall, block
    // or fly. Both reach the brain as touch; antennal contact is what makes the fly turn away (st.antTouch)
    const fx = Rt9(d.xmat, B.thorax);
    st.frontTouch = {}; st.antTouch = {};
    for (const sd of ['left', 'right']) { const a = st.antenna[sd], tip = [a[0] + 0.02 * fx[0], a[1] + 0.02 * fx[1]];
      st.antTouch[sd] = clearance(tip, this.env, this.others, a[2]) < 0.003;
      st.frontTouch[sd] = st.antTouch[sd] || clearance(st.claw[`T1_${sd}`], this.env, this.others) < 0; }
    // a static surface just ahead (~1.7 mm): its looming matches the fly's own translation
    const hp = P(B.head); st.nearAhead = clearance([hp[0] + 0.12 * fx[0], hp[1] + 0.12 * fx[1]], this.env, this.others, hp[2]) < 0.05;
    if (this.flight.active) {   // flight: clearance at the lookahead point ahead and 40 degrees to each side
      const L = 0.9, yaw = Math.atan2(fx[1], fx[0]), at = a => clearance([st.pos[0] + L * Math.cos(yaw + a), st.pos[1] + L * Math.sin(yaw + a)], this.env, this.others, st.pos[2]);
      st.ahead = { center: at(0), left: at(0.7), right: at(-0.7) };
    }
    return st;
  }
  albedo = (g, x, y) => {
    const k = this.geomKind[g], L = this.look;
    if (k === 'threat') return 0.03;
    if (k === 'monster') return 0.04;   // near-black: a dark mass looming, not a bright object
    if (k === 'floor') return L.floorLo + (L.floorHi - L.floorLo) * (((Math.floor(x / 0.4) + Math.floor(y / 0.4)) & 1) ? 1 : 0);   // checker floor
    if (k === 'wall') { const a = Math.atan2(y, x); return L.wallLo + (L.wallHi - L.wallLo) * ((Math.floor(a / (Math.PI / 12)) & 1) ? 1 : 0); }  // striped wall
    if (k === 'food') return 0.9; if (k === 'bitter') return 0.5; if (k === 'hazard') return 0.6; if (k === 'obst') return 0.12; if (k === 'fly') return 0.08;
    return 0.3;
  };
  /** advance 1 ms of simulated time */
  step() {
    if (!this.alive) return;
    const _p = PROF.on; let _a = _p ? performance.now() : 0;
    const _t = _p ? (k) => { const n = performance.now(); _p[k] += n - _a; _a = n; } : () => {};
    const mj = this.mj, M = this.model, d = this.mjd;
    const th = this.env.threat, tm = this.threatMocap * 3;
    if (th) { d.mocap_pos[tm] = th.x; d.mocap_pos[tm + 1] = th.y; d.mocap_pos[tm + 2] = th.z; } else if (d.mocap_pos[tm + 2] > -10) d.mocap_pos[tm + 2] = -20;
    const mo = this.env.monster, mm = this.monsterMocap * 3;
    if (mo) { d.mocap_pos[mm] = mo.x; d.mocap_pos[mm + 1] = mo.y; d.mocap_pos[mm + 2] = mo.z; } else if (d.mocap_pos[mm + 2] > -10) d.mocap_pos[mm + 2] = -20;
    const st = this.state();
    _t('state');
    const rates = this.senses.update(st, this.env, 1); this._sugar = st.sugar;
    _t('senses');
    // `state()` builds a fresh st each call, so anything Senses writes onto st is gone by the time
    // postPose() runs. Keep the scalars the host wants to display on the agent itself.
    this.heatFelt = st.heat || 0; this.songHeard = st.song || 0;
    if (this.eye && (this.t % 10 === 0)) { this._eyeRates = new Map(); const er = this._eyeRates; this.eye.update({ set: (ix, hz) => { for (const i of ix) er.set(i, hz); } }, this.env, 10, this.albedo); this._eyeDirty = true; }
    if (this.fv && (this.t % 20 === 0)) { this._eyeRates = new Map(); const er = this._eyeRates; this.fv.update((ix, hz) => { for (const i of ix) er.set(i, hz); }, this.env, this.albedo, 20); this._eyeDirty = true; }
    if (_p && this.t % 47 === 3 && this._eyeRates) {
      let ov = 0; for (const i of this._eyeRates.keys()) if (rates.has(i)) ov++;
      _p.nOverlap += ov;
    }
    // VISION IS NOT COPIED THROUGH `rates` ANY MORE.
    //
    // The optic lobe drives ~28,400 neurons and refreshes every 10 or 20 simulated ms. Merging it
    // into the per-millisecond rate map meant walking those 28,400 entries twice every single
    // millisecond -- once to copy them in, once to write them to the brain -- to re-send numbers
    // that had not changed 9 times out of 10. That copy and the write it caused were two thirds of
    // the whole simulation step.
    //
    // Measured with nOverlap: nothing else drives a neuron the eye drives, so vision can be written
    // on its own cadence. `rates` still wins where the two ever do meet, because the rates loop
    // below runs after this one -- the same precedence the merge gave it.
    _t('vision');
    // apply sensory drive
    const B = this.brain;
    _t('driveClear');
    if (this.neuromod) this.neuromod.update(1, this.energy, this.flight.active ? 1 : this.motor.stepAmp || 0);
    // courtship context for a male: the nearest other fly's range and bearing in his head frame, plus the
    // connectome's own courtship-circuit readout (pIP10, DNp13) from the previous step
    let court = null;
    if (this.sex !== 'f' && st.otherFlies.length) {
      const fx = Rt9(d.xmat, this.bid.thorax), yaw = Math.atan2(fx[1], fx[0]);
      for (const o of st.otherFlies) {
        if (o.sex !== 'f') continue;   // a male courts only a female target
        const dd = Math.hypot(o.x - st.pos[0], o.y - st.pos[1]);
        if (!court || dd < court.dist) { const a = Math.atan2(o.y - st.pos[1], o.x - st.pos[0]) - yaw; court = { dist: dd, bearing: Math.atan2(Math.sin(a), Math.cos(a)) }; }
      }
      if (court) court.level = this.motor.cmd.court || 0;
      // LC10 drive: a nearby fly subtends a small moving object on the eye. Salience ~ angular size,
      // gated to the frontal-lateral field; the ipsilateral LC10 population carries it to pIP10
      for (const o of st.otherFlies) {
        const a = Math.atan2(o.y - st.pos[1], o.x - st.pos[0]) - Math.atan2(fx[1], fx[0]);
        const bearing = Math.atan2(Math.sin(a), Math.cos(a));
        const dd = Math.hypot(o.x - st.pos[0], o.y - st.pos[1]);
        const angular = Math.atan2(0.13, dd);              // fly ~1.3 mm radius
        if (Math.abs(bearing) < 2.2 && dd < 3 && angular > 0.04) {
          const hz = Math.min(140, 200 * angular);         // saturating small-object response
          const pool = this.lc10[bearing > 0 ? 'left' : 'right'];
          // consult the eye map as well as `rates`: vision is no longer merged into `rates`, so
          // reading only `rates` here would lose the eye's own contribution to the comparison
          for (let k = 0; k < pool.length; k += 4) if ((rates.get(pool[k]) ?? this._eyeRates?.get(pool[k]) ?? 0) < hz) rates.set(pool[k], hz);   // ~1/4 of the column: the object covers part of the visual field
        }
      }
    }
    // Hold an explicit request until the startup/contact gates actually permit a launch.
    // The former 80 ms pulse silently expired if the user clicked just after loading.
    if (this.takeoffPending && this.intrinsic) this.intrinsic.takeoffUntil = this.intrinsic.t + 80;
    if (this.intrinsic) this.intrinsic.update(1, B, { energy: this.energy, arousal: this.neuromod?.arousal, touch: st.antTouch, rearing: st.pitchUp > 0.45 && this.motor.jumpT < 0 && !this.motor.righting,
      heat: { left: heatAt(st.antenna.left, this.env), right: heatAt(st.antenna.right, this.env) }, heatFeet: this.heatFeetFelt || 0, up: this.mjd.xmat[this.bid.thorax * 9 + 8], sugar: this._sugar || 0, flying: this.flight.active, ahead: st.ahead, court,
      mouthOnFood: this.env.food.some(f => f.amount > 0 && Math.hypot(st.labellum[0] - f.x, st.labellum[1] - f.y) < f.r - 0.02) });
    _t('intrinsic');
    // WRITE ONLY WHAT CHANGED.
    //
    // This used to clear every driven neuron to 0 and then write every rate back, every simulated
    // millisecond. setDriveOne already skips a write when the rate is unchanged -- but clearing
    // first defeats that guard, because 0 always differs from the old rate and the old rate always
    // differs from 0. So each driven neuron queued TWO GPU deltas per millisecond whether or not
    // anything about it had changed.
    //
    // Most of them had not. The flyvis optic lobe refreshes on a 20 ms cadence and its rates are
    // cached in _eyeRates in between, so ~19 out of every 20 milliseconds re-sent thousands of
    // identical numbers. Measured over a 20 s window: clear + set was 47% of the entire simulation
    // step -- 13.6 ms of the 29 ms each simulated millisecond cost -- against 14% for the physics
    // and 12% for the brain itself.
    //
    // Setting first and then zeroing only the neurons that dropped out leaves exactly the same
    // state: drive[i] = rates[i] for everything in rates, 0 for everything that left it.
    const er = this._eyeRates;
    if (this._eyeDirty) {
      for (const [i, hz] of er) B.setDriveOne(i, hz);
      // neurons the eye drove last refresh and does not drive now
      if (this.drivenEye) for (const i of this.drivenEye) if (!er.has(i)) B.setDriveOne(i, 0);
      this.drivenEye = Int32Array.from(er.keys());
      this._eyeDirty = false;
    }
    const nd = new Int32Array(rates.size); let k = 0; for (const [i, hz] of rates) { B.setDriveOne(i, hz); nd[k++] = i; }
    // A neuron that leaves `rates` goes back to whatever the eye is driving it with, not to silence
    // -- otherwise a one-millisecond LC10 command would switch off a photoreceptor until the next
    // optic-lobe refresh.
    for (const i of this.driven) if (!rates.has(i)) B.setDriveOne(i, er && er.has(i) ? er.get(i) : 0);
    this.driven = nd;
    _t('driveSet');
    // HOW MUCH OF THAT WRITE WAS NEW? Sampled every 50th step so the counting does not distort the
    // timing it is meant to explain. `changed` is what the GPU actually had to be told; `rates` is
    // what we walked to find it out. A large gap between them means the cost is the bookkeeping,
    // not the data.
    if (_p && this.t % 47 === 3) {
      // fround, for the same reason setDriveOne needs it: `drive` is a Float32Array, so comparing
      // its read-back against a double reports every value as changed
      let ch = 0; for (const [i, hz] of rates) if (B.drive[i] !== Math.fround(hz)) ch++;
      const erc = this._eyeRates;
      _p.nRates += rates.size; _p.nEye += erc ? erc.size : 0; _p.nChanged += ch; _p.nSamp++;
      _a = performance.now();   // do not bill the counting to any phase
    }
    // GF -> TTMn electrical synapse (not in the chemical connectome): GF spikes depolarise TTMn directly
    const before = this.brain.spikeCount[this.motor.dn.escape[0]] + this.brain.spikeCount[this.motor.dn.escape[1]];
    this.brain.step(); this.brain.step();
    _t('brain');
    const after = this.brain.spikeCount[this.motor.dn.escape[0]] + this.brain.spikeCount[this.motor.dn.escape[1]];
    if (after > before) this.brain.pulse(this.motor.ttmn, 20);
    this.motor.readBrain(this.brain.spikeCount, 1);
    _t('readBrain');
    // escape gating: a static surface the fly is walking up to, touching, or backing away from looms on the eye,
    // its own pivots sweep the scene across the eye, and grooming legs pass over it. Touch, optic flow that matches
    // its own translation, and efference copies of its movements (Kim et al. 2015) tell the brain none is a predator.
    if (st.frontTouch.left || st.frontTouch.right || st.nearAhead || st.bodyContact.left || st.bodyContact.right || this.intrinsic?.avoid || this.cmd?.grooming) this.lastTouch = this.t;
    if (this.motor.pivot) this.lastPivot = this.t;
    const gated = this.t - (this.lastTouch ?? -1e9) < 500 || this.t - (this.lastPivot ?? -1e9) < 300;
    this.motor.flying = this.flight.active;
    this.cmd = this.motor.apply(this.t, 1, { up: this.mjd.xmat[this.bid.thorax * 9 + 8],
      // WHICH SIDE IS UP. xmat is row-major, so [8] is the world-z component of the body's z
      // axis (`up`) and [7] is the world-z component of its y axis. In flybody local +y is the
      // animal's LEFT, so roll > 0 means the left flank is raised and the animal is lying on its
      // RIGHT. The righting reflex needs this: it pushes with one side, and pushing with the
      // side that is already underneath drives the animal further onto it.
      roll: this.mjd.xmat[this.bid.thorax * 9 + 7], touching: gated, voluntary: this.takeoffPending || (this.intrinsic && this.t < this.intrinsic.takeoffUntil),
      court: this.intrinsic?.state === 'court' ? { sing: !!this.intrinsic.courtSing, side: this.intrinsic.courtSide } : null,
      contact: st.bodyContact.left || st.bodyContact.right || st.antTouch.left || st.antTouch.right,   // no takeoff while pressed against something
      urgent: !!(this.intrinsic && this.t < this.intrinsic.urgentUntil) });                            // ...unless the substrate is burning it
    // takeoff: once the jump has pushed off, the wings start (tarsal reflex); an escape banks away from the threat
    if (this.motor.launchT === this.t && !this.flight.active) {
      const th = this.env.threat; this.flight.start(this.t, { cause: this.motor.jumpCause, awayFrom: th ? [th.x, th.y] : null }); this.flights++; this.takeoffPending = false;
    }
    if (this.flight.active) {
      const legTouch = Object.values(st.touch).some(x => x > 0);
      if (this.flight.update(this.t, 1, { turn: this.cmd.turn, env: this.env, others: this.others, legTouch }) === 'landed') this.motor.recoverUntil = this.t + 300;
      this.cmd.flying = this.flight.active; this.cmd.flight = this.flight.label();
    }
    _t('motor');
    const dtSub = 1000 * M.opt.timestep;
    for (let s = 0; s < this.physPerMs; s++) { if (this.flight.active) this.flight.substep(dtSub); mj.mj_step(M, d); }
    _t('physics');
    this.mb?.step(1);            // associative memory: reads traces, injects learned depression
    _t('mushroom');
    this.t += 1;
    this.physiology(st);
    _t('physiology');
    if (_p) _p.steps++;
  }
  physiology(st) {
    const dt = 0.001;
    if (this._lastPos) this.dist += Math.hypot(st.pos[0] - this._lastPos[0], st.pos[1] - this._lastPos[1]); this._lastPos = st.pos;
    const jumping = this.motor.jumping; if (jumping && !this._wasJumping) this.jumps++; this._wasJumping = jumping;
    const walking = Math.abs(this.cmd.v);
    this.energy -= dt * (1 / 240 + walking / 180 + (this.flight.active ? 1 / 40 : 0));   // compressed timescale: ~4 min to starve at rest; flight is costly
    // ingestion: labellum on food + proboscis extended + pharyngeal pump motor neurons active
    if (st.labellumZ < 0.065 && st.proboscisOut) for (const f of this.env.food) {
      if (f.amount > 0 && Math.hypot(st.labellum[0] - f.x, st.labellum[1] - f.y) < f.r) {
        const intake = dt * 0.15 * f.sugar * (0.3 + 0.7 * this.motor.feeding());
        f.amount -= intake; this.energy += intake; this.eaten += intake; this.foodEaten[this.env.food.indexOf(f)] += intake; }
    }
    // --- injury ---------------------------------------------------------------------------
    // BURNS ARE MEASURED AT THE FEET, NOT THE THORAX. The previous test was `st.heat > 0.5`,
    // where st.heat is sampled at the thorax -- and the thorax stands at z = 0.13, where heat has
    // already decayed by exp(-0.13/0.28) = 0.629. Against a hazard of 0.5 the thorax can read at
    // most 0.314, so the threshold was unreachable and NOTHING could ever be burned. Across five
    // thermal runs the animals sat in heat of 0.306-0.340 and took no damage, which was read as a
    // failure to escape without noticing they were also invulnerable. The tarsi are what touch
    // the substrate, so that is where a burn is incurred.
    let heatFeet = 0;
    for (const k of Object.keys(this.claw)) { const h = heatAt(st.claw[k], this.env); if (h > heatFeet) heatFeet = h; }
    // On the AGENT, not on st: state() builds a fresh object each call, so a value written onto
    // st here is gone before postPose() reads it. Same trap as heatFelt/songHeard above.
    st.heatFeet = heatFeet; this.heatFeetFelt = heatFeet;
    const burn = Math.max(0, heatFeet - BURN.floor);
    if (burn > 0) this.health -= dt * BURN.rate * burn;

    // --- predation -------------------------------------------------------------------------
    // The monster is deliberately non-colliding (contype 0 in world.js) so it cannot wedge the
    // physics solver against a fly. That also meant it could not touch the animal in any sense:
    // it was a dark shape that moved, and nothing in the health calculation referred to it. A
    // predator that cannot harm is scenery. Damage is therefore applied by proximity, which keeps
    // the solver untouched, and is reported so a death can be attributed.
    const mo = this.env.monster;
    if (mo && this.alive) {
      const d = Math.hypot(st.pos[0] - mo.x, st.pos[1] - mo.y, (st.pos[2] || 0) - (mo.z ?? 0.13));
      if (d < BITE.reach) {
        this.health -= dt * BITE.rate * (1 - d / BITE.reach);
        this.lastHarm = 'monster';
      }
    }
    if (burn > 0) this.lastHarm = 'burn';
    if (this.energy <= 0) { this.energy = 0; this.health -= dt * 0.2; this.lastHarm = 'starvation'; }
    this.energy = Math.min(1, this.energy);
    this.health = Math.min(1, this.health);
    if (this.health <= 0 && this.alive) { this.alive = false; this.health = 0; }
  }
  behavior(st) {
    const c = this.cmd || {}; const m = this.motor;
    if (!this.alive) return 'dead';
    if (c.righting) return 'righting';
    if (this.flight.active) return this.flight.label();
    if (m.jumping) return m.jumpCause === 'voluntary' ? 'taking off' : 'escape jump';
    if (this.intrinsic?.state === 'court') return c.singing ? 'singing (courtship)' : 'courting';
    if (c.grooming) return 'grooming';
    if (st && st.proboscisOut && st.labellumZ < 0.065 && this.env.food.some(f => f.amount > 0 && Math.hypot(st.labellum[0] - f.x, st.labellum[1] - f.y) < f.r)) return 'feeding';
    const pe = st && st.proboscisOut ? ' (proboscis out)' : '';
    if (c.v < -0.05) return 'walking backward' + pe;
    if (c.v > 0.05) return (Math.abs(c.turn) > 0.3 ? (c.turn > 0 ? 'turning left' : 'turning right') : 'walking') + pe;
    return pe ? 'proboscis extended' : 'standing';
  }
  pose() { const d = this.mjd; return { xpos: d.xpos.slice(0), xquat: d.xquat.slice(0) }; }
}

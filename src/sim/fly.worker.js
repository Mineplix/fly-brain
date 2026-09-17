// One embodied fly per worker: its own connectome brain + MuJoCo physics world.
import loadMujoco from '@mujoco/mujoco';
import { FlyAgent } from './fly.js';
import { attachBrain, attachEyes } from '../brainsetup.js';
import { buildGroups, GroupMeter } from './groups.js';
import { RIGHT } from './motor.js';

let fly = null, meter = null, running = false, speed = 1, others = [], env = null, lastReal = 0, simAhead = 0, timer = null;
let proxyIds = [], lastPose = -Infinity, loopActive = false;
const POSE_EVERY = 1000 / 30; // wall ms: twelve workers must not flood the render thread

onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    const mj = await loadMujoco();
    const g = m.graph;
    const data = { N: g.N, E: g.E, meta: m.meta, indptr: g.indptr, indices: g.indices, weights: g.weights, nt: g.nt, side: g.side, superclass: g.superclass, cls: g.cls };
    env = m.env;
    const brain = await attachBrain(m.wasmModule, m.brainMem, m.slot, data, 101 + m.id);
    const flyvis = m.brainMem.fv ? { eyes: attachEyes(brain.instance, m.brainMem, m.slot), map: m.flyvisMap, gain: 150 } : null;
    fly = new FlyAgent({ brain, flyvis, mj, flyXML: m.flyXML, env, data, size: g.size, sign: g.sign, bodymap: m.bodymap, gait: m.gait, id: m.id,
      pos: m.pos, yaw: m.yaw, nProxies: m.nProxies, mode: m.mode, brainOpts: m.brainOpts, vision: m.vision, neuromod: { calib: m.neuromod }, sex: m.sex, look: m.look, mushroom: m.mushroom, learn: m.learn, etaMul: m.etaMul, mbParams: m.mbParams, noci: m.noci, dnAll: m.dnAll });
    meter = new GroupMeter(buildGroups(m.bodymap, data.meta.types, data.side), g.N);
    proxyIds = Array.from({ length:m.nProxies }, (_,k) => fly.model.body_mocapid[fly.model.body(`proxy${k}`).id]);
    // A saved brain: the mushroom-body depression array from a previous session. Length is
    // checked here as well as in flystore, because loading a wrong-length overlay would index
    // a different edge list and quietly scramble every learned weight.
    if (m.mbState && fly.mb) {
      const src = new Float32Array(m.mbState);
      if (src.length === fly.mb.depress.length) { fly.mb.depress.set(src); fly.mb.dirty = true; }
      else console.warn(`[fly ${m.id}] saved brain has ${src.length} edges, this index has ${fly.mb.depress.length} -- ignored`);
    }
    if (m.restore) { if (typeof m.restore.energy === 'number') fly.energy = m.restore.energy; if (typeof m.restore.health === 'number') fly.health = m.restore.health; }
    postMessage({ type: 'ready', id: m.id, noci: fly.nociCounts || null, vpFix: fly.vpFix || null, dnAll: !!fly.motor?.useAllDN, dnN: fly.motor?.dnAllIdx?.length || 0, nbody: fly.model.nbody, bodyNames: [...Array(fly.model.nbody).keys()].map(i => fly.model.body(i).name), wingPoses: fly.flight.wingPoses(mj) });
    postPose();
    if (running) { lastReal = performance.now(); loop(); }
  } else if (m.type === 'run') { if (running) return; running = true; lastReal = performance.now(); clearTimeout(timer); if (fly) loop(); }   // before init: loop starts once ready; clearTimeout kills a pending reschedule from a paused loop
  else if (m.type === 'pause') { running = false; clearTimeout(timer); }
  else if (m.type === 'speed') speed = m.speed;
  else if (m.type === 'env') { Object.assign(env, m.env); fly.env = env; if (fly.foodEaten.length !== env.food.length) fly.foodEaten = env.food.map(() => 0); }
  else if (m.type === 'others') { others = m.others; fly.others = others; setProxies(); }
  else if (m.type === 'mode') fly.motor.mode = m.mode;
  // Restaging the arena changes what the surfaces reflect, so the flies' vision changes too.
  else if (m.type === 'look') { fly.look = m.look; fly.fv && (fly.fv.settled = false); }
  else if (m.type === 'stimulate') fly.brain.setDrive(m.indices, m.rate);
  else if (m.type === 'learn') { if (fly.mb) fly.mb.learn = !!m.on; }
  // Revive as well as heal: a dead fly is dead only because health reached zero, and the body is
  // otherwise intact, so restoring health is enough to put it back on its feet.
  else if (m.type === 'heal') {
    fly.health = 1; fly.alive = true; fly.lastHarm = null;
    if (typeof m.energy === 'number') fly.energy = m.energy;
    postPose();
  }
  else if (m.type === 'mbreset') { fly.mb?.reset(); if (fly.mb) fly.mb.stats.phasicPeak = 0; }
  // Hand the learned mushroom-body weights back for saving. A copy is transferred, so the
  // running overlay is untouched and the main thread pays no structured-clone cost.
  else if (m.type === 'exportmb') {
    const buf = fly?.mb ? fly.mb.depress.slice(0).buffer : null;
    postMessage({ type: 'mb', id: fly?.id, token: m.token, mb: buf, dirty: !!fly?.mb?.dirty, simMs: fly?.t || 0,
      energy: fly?.energy, health: fly?.health, pos: fly ? [fly.mjd.xpos[fly.bid.thorax * 3], fly.mjd.xpos[fly.bid.thorax * 3 + 1]] : null },
      buf ? [buf] : []);
  }
  else if (m.type === 'probe') {
    const M = fly.model, d = fly.mjd; let gid = -1;
    const want = m.geom || 'monster_geom';
    for (let g = 0; g < M.ngeom; g++) if (M.geom(g).name === want) gid = g;
    const jm = fly.monsterMocap;
    postMessage({ type: 'probe', gid, kind: gid >= 0 ? fly.geomKind[gid] : null, mocapId: jm,
      mocapPos: [d.mocap_pos[jm*3], d.mocap_pos[jm*3+1], d.mocap_pos[jm*3+2]],
      geomPos: gid >= 0 ? [d.geom_xpos[gid*3], d.geom_xpos[gid*3+1], d.geom_xpos[gid*3+2]] : null,
      geom: want, envMonster: fly.env.monster, albedo: gid >= 0 ? fly.albedo(gid, 0, 0) : null,
      nmocap: M.nmocap, hits: fly.fv ? (() => { const gv = fly.fv.gid.GetView(); let n = 0; for (let i = 0; i < gv.length; i++) if (gv[i] === gid) n++; return n; })() : 'no-fv' });
  }
  // Put the animal on its back, on demand. Righting can only be studied on an animal that is
  // actually inverted, and waiting for one to fall over means waiting on a hazard that also kills
  // it -- which confounds "righting failed" with "died before it finished". This makes the state
  // reproducible and separates the two.
  else if (m.type === 'flip') {
    const d = fly.mjd, a = fly.jointAdr['free'];
    d.qpos[a + 2] = m.z ?? 0.30;                    // clear of the floor so it lands rather than clips
    d.qpos[a + 3] = 0; d.qpos[a + 4] = 1;           // quaternion (w,x,y,z) = 180 deg about x: supine
    d.qpos[a + 5] = 0; d.qpos[a + 6] = 0;
    for (let i = 0; i < d.qvel.length; i++) d.qvel[i] = 0;
    fly.mj.mj_forward(fly.model, d);
    fly.motor.righting = false; fly.motor.invertedMs = 0;   // start the reflex from a clean state
    postPose();
  }
  // Adjust a reflex constant at runtime, so a harness can measure the SAME animal in the same
  // session with a behaviour on and off. Without this an A/B costs two page loads and two
  // connectome loads, and the two arms differ by everything that differs between two runs.
  else if (m.type === 'tune') { if (m.right) Object.assign(RIGHT, m.right); postPose(); }
  // WHAT IS THE ANIMAL TOUCHING? A righting reflex is a lever, and a lever needs a fulcrum: if a
  // supine fly's legs point away from the substrate and its wing never reaches it either, the
  // motion is a flail in free air and no amount of gain or phasing will turn it over. That is a
  // different repair from a push that lands but is too weak, and the two are indistinguishable from
  // `up` alone -- which is why three guesses at the reflex constants got nowhere.
  else if (m.type === 'contacts') {
    const d = fly.mjd, cv = d.contact, n = Math.min(d.ncon, cv.size());
    const byName = {}; let floorCon = 0;
    for (let c = 0; c < n; c++) {
      const con = cv.get(c);
      const g1 = con.geom1, g2 = con.geom2;
      const k1 = fly.geomKind[g1], k2 = fly.geomKind[g2];
      if (k1 === 'floor' || k2 === 'floor') {
        floorCon++;
        const self = k1 === 'floor' ? g2 : g1;
        const nm = fly.model.geom(self).name || `geom${self}`;
        byName[nm] = (byName[nm] || 0) + 1;
      }
      con.delete();
    }
    cv.delete();
    postMessage({ type: 'contacts', ncon: d.ncon, floor: floorCon, parts: byName,
      up: fly.mjd.xmat[fly.bid.thorax * 9 + 8], roll: fly.mjd.xmat[fly.bid.thorax * 9 + 7],
      righting: !!fly.motor.righting });
  }
  else if (m.type === 'takeoff') { fly.requestTakeoff(); postPose(); }
  else if (m.type === 'joints') {
    // What is actually being commanded to each leg joint, and how close it sits to the limit of
    // its range. The VNC readout question -- does the connectome fail to hold a posture, or does
    // our mapping from motor-neuron firing to joint angle saturate? -- cannot be answered from
    // the outside, because both look identical: a collapsed fly. `sat` is the fraction of the
    // way from the centre of the joint's range to whichever end it is nearer, so 1.0 means the
    // joint is pinned at a limit and the readout has no headroom left.
    // `sat` IS MEASURED FROM REST, NOT FROM THE RANGE CENTRE, and the distinction is the whole
    // value of this instrument. muscleCtrl maps balanced motor-neuron drive to `rest` (0 for every
    // leg joint) and scales each direction to its own limit, so the headroom that matters is the
    // fraction of the way from 0 to whichever limit the joint is nearer -- which is exactly |net|.
    // Measuring from the centre of the range instead says a joint resting at 0 is already
    // saturated wherever the range is asymmetric about 0: the front-leg femur runs -0.15 to 2.0,
    // centre 0.925, so a perfectly neutral joint scored 0.86 and a handful scored above 0.95. That
    // produced a standing count of "4 to 8 of 48 joints pinned" across runs on 2026-09-15/16 which
    // was reported as the read-out having no headroom. It was the SATURATION METRIC that had no
    // headroom. `satMid` keeps the old quantity so the two can be compared rather than swapped
    // silently, and `outside` flags any joint whose range does not contain rest at all, which
    // would be a real fault rather than a measurement one.
    const mo = fly.motor, ctrl = fly.mjd.ctrl, out = [];
    for (const [name, i] of Object.entries(mo.act)) {
      if (!/^(coxa|femur|tibia|tarsus)/.test(name)) continue;
      const [lo, hi] = mo.range[name], v = ctrl[i], mid = (lo + hi) / 2, half = (hi - lo) / 2;
      const rest = 0;
      const span = v >= rest ? hi - rest : rest - lo;
      out.push({ j: name, v: +v.toFixed(4), lo: +lo.toFixed(3), hi: +hi.toFixed(3),
                 sat: span > 0 ? +Math.min(1, Math.abs(v - rest) / span).toFixed(3) : 0,
                 satMid: half > 0 ? +Math.min(1, Math.abs(v - mid) / half).toFixed(3) : 0,
                 outside: lo > rest || hi < rest,
                 // How many muscles the connectome maps to this actuator in each direction. A joint
                 // with drive in only ONE direction has no antagonist that can bring it back, so
                 // any sustained firing walks it to a limit and leaves it there -- and no amount of
                 // gain calibration in muscleCtrl can fix a missing opponent. Averaging per
                 // direction bounded net to [-1,1] and stopped the animal toppling, but left 10 of
                 // 48 joints pinned, which is the signature this counts directly.
                 nExt: mo.muscles.filter(x => x.actuator === name && x.dir > 0).length,
                 nFlex: mo.muscles.filter(x => x.actuator === name && x.dir <= 0).length,
                 // THE FIRING RATES THEMSELVES, in Hz, per direction. The two hypotheses that a
                 // pinned joint was a metric artefact or a missing antagonist were both refuted by
                 // measurement; the remaining candidate is that READOUT.muscleHalf (17 Hz) is far
                 // below the rates the connectome actually produces, in which case a = 1 - exp(-r *
                 // ln2 / 17) is near 1 for any brisk pool and every joint saturates by construction.
                 // That is a claim about numbers, so here are the numbers.
                 hzExt: +Math.max(0, ...mo.muscles.filter(x => x.actuator === name && x.dir > 0)
                   .map(x => mo.mean(x.idx))).toFixed(1),
                 hzFlex: +Math.max(0, ...mo.muscles.filter(x => x.actuator === name && x.dir <= 0)
                   .map(x => mo.mean(x.idx))).toFixed(1) });
    }
    // per-muscle activation actually arriving from the motor neurons this step
    const drive = [];
    for (const mus of (fly.motor.muscles || []).slice(0, 400)) {
      const r = mo.mean(mus.idx || []);
      if (r > 0.5) drive.push({ m: mus.name, act: mus.actuator, dir: mus.dir, hz: +r.toFixed(1), n: (mus.idx || []).length });
    }
    drive.sort((a, b) => b.hz - a.hz);
    postMessage({ type: 'joints', id: fly.id, mode: mo.mode, joints: out, drive: drive.slice(0, 20),
      nDriven: drive.length, stepAmp: +(mo.stepAmp || 0).toFixed(3), v: +((mo.cmd && mo.cmd.v) || 0).toFixed(3) });
  }
  else if (m.type === 'census') {
    // "Is the whole network being used?" answered as a count rather than an assertion. For every
    // superclass: how many neurons exist, and how many have emitted at least one spike since the
    // brain was built. A population with zero spikers is either genuinely silent or receiving no
    // input at all -- the distinction that hid the VNC nociceptors and the auditory afferents.
    // `data` is const-scoped to the init branch, so reach it through the agent, which keeps it.
    const sc = fly.data.superclass, names = fly.data.meta.superclasses, cnt = fly.brain.spikeCount;
    const tot = new Int32Array(names.length), live = new Int32Array(names.length), spikes = new Float64Array(names.length);
    for (let i = 0; i < sc.length; i++) { const k = sc[i]; tot[k]++; if (cnt[i] > 0) { live[k]++; spikes[k] += cnt[i]; } }
    postMessage({ type: 'census', id: fly.id, t: fly.t, names,
      tot: Array.from(tot), live: Array.from(live), spikes: Array.from(spikes),
      driven: fly.driven.length });
  }
  else if (m.type === 'activity') {
    const eyes = fly.fv ? fly.fv.lumEye.map(e => e.slice(0)) : null;
    postMessage({ type: 'activity', id: fly.id, trace: fly.brain.trace.slice(0), t: fly.t, groups: meter.read(fly.brain.spikeCount, fly.t), eyes });
  }
};
function setProxies() {
  const d = fly.mjd;
  proxyIds.forEach((mid, k) => {
    const o = others[k];
    if (!o) { d.mocap_pos[mid * 3] = 50 + k; d.mocap_pos[mid * 3 + 1] = 50; d.mocap_pos[mid * 3 + 2] = -5; return; }
    d.mocap_pos[mid * 3] = o.x; d.mocap_pos[mid * 3 + 1] = o.y; d.mocap_pos[mid * 3 + 2] = o.z ?? 0.13;
    d.mocap_quat[mid * 4] = Math.cos(o.yaw / 2); d.mocap_quat[mid * 4 + 1] = 0; d.mocap_quat[mid * 4 + 2] = 0; d.mocap_quat[mid * 4 + 3] = Math.sin(o.yaw / 2); });
}
function postPose() {
  lastPose = performance.now();
  const p = fly.pose(); const st = fly.state();
  postMessage({ type: 'pose', id: fly.id, t: fly.t, xpos: p.xpos, xquat: p.xquat, cmd: fly.cmd, energy: fly.energy, health: fly.health, alive: fly.alive, eaten: fly.eaten, takeoffPending:fly.takeoffPending,
    mn9: fly.motor.mean(fly.motor.muscles.find(x => x.name.startsWith('MN9'))?.idx || []), feeding: fly.motor.feeding(), heat: fly.heatFelt ?? st.heat ?? 0, heatFeet: fly.heatFeetFelt || 0, harm: fly.lastHarm || null, dbg: fly.intrinsic ? { toUntil: fly.intrinsic.takeoffUntil|0, t: fly.intrinsic.t|0, lastBurnFly: fly.intrinsic.lastBurnFly|0, hot: +(fly.intrinsic.hot||0).toFixed(3),
      urgentUntil: fly.intrinsic.urgentUntil|0, veto: fly.motor.jumpVeto || null, vetoT: fly.motor.jumpVetoT|0 } : null, song: fly.songHeard || 0, nSensory: fly.driven.length,
    foodEaten: fly.foodEaten.splice(0, fly.foodEaten.length, ...fly.foodEaten.map(() => 0)), behavior: fly.behavior(st), singing: !!fly.cmd?.singing, drive: fly.intrinsic?.label(), nm: fly.neuromod?.readout(), mb: fly.mb ? { warm: fly.mb._age > fly.mb.p.warmupMs, kc: +fly.mb.stats.kcDrive.toFixed(2), dan: +fly.mb.stats.danDrive.toFixed(2), edges: fly.mb.stats.edges, learning: fly.mb.dirty, depressed: fly.mb.stats.depressed, maxDep: +fly.mb.stats.maxDepress.toFixed(3), meanDep: +fly.mb.stats.meanDepress.toFixed(5), mbon: +fly.mb.stats.mbonDrive.toFixed(2), mExc: +fly.mb.stats.mbonExc.toFixed(2), mInh: +fly.mb.stats.mbonInh.toFixed(2), mAver: +fly.mb.stats.mbonAver.toFixed(2), mAppet: +fly.mb.stats.mbonAppet.toFixed(2), phasic: +fly.mb.stats.phasicMax.toFixed(4), peak: +fly.mb.stats.phasicPeak.toFixed(4), gate: +fly.mb.stats.gate.toFixed(3), popRel: +fly.mb.stats.popRel.toFixed(3), pop: +fly.mb.stats.pop.toFixed(2), popFast: +fly.mb.stats.popFast.toFixed(2), popBase: +fly.mb.stats.popBase.toFixed(2), popAv: +fly.mb.stats.popAv.toFixed(2), avRel: +fly.mb.stats.avRel.toFixed(3) } : null, flying: fly.flight.active, flights: fly.flights, dist: fly.dist, jumps: fly.jumps, pos: st.pos, up: +fly.mjd.xmat[fly.bid.thorax * 9 + 8].toFixed(3),
    roll: +fly.mjd.xmat[fly.bid.thorax * 9 + 7].toFixed(3), yaw: Math.atan2(fly.mjd.xmat[fly.bid.thorax * 9 + 3], fly.mjd.xmat[fly.bid.thorax * 9]) }, [p.xpos.buffer, p.xquat.buffer]);
}
async function loop() {
  if (!running || loopActive) return;
  loopActive = true;
  const now = performance.now(); simAhead += Math.min(100, now - lastReal) * speed; lastReal = now;
  const t0 = performance.now(); let steps = 0;
  // Bound both CPU bursts and GPU work in flight. An unbounded compute queue stalls WebGL
  // and leaves the motor reading increasingly old brain state when many flies share the GPU.
  while (running && simAhead >= 1 && steps < 8 && performance.now() - t0 < 8) { fly.step(); simAhead -= 1; steps++; }
  fly.brain.flush?.();
  if (steps && fly.brain.device) await fly.brain.device.queue.onSubmittedWorkDone();
  if (simAhead > 50) simAhead = 50;   // can't keep up: run as fast as possible
  if (steps && (!running || performance.now() - lastPose >= POSE_EVERY)) postPose();
  loopActive = false;
  if (running) timer = setTimeout(loop, 0);
}

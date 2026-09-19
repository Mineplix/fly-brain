// One embodied fly per worker: its own connectome brain + MuJoCo physics world.
// THE PACKAGE SHIPS TWO BUILDS and this project has only ever used the single-threaded one.
//
// `@mujoco/mujoco/mt` is a pthreads build. It needs SharedArrayBuffer, which this page already has
// -- vite.config.js sets COOP/COEP because the connectome is shared across workers -- so the only
// question is whether threading a ~100-DOF model actually pays, and that is a measurement, not an
// assumption: MuJoCo's step is largely sequential and thread overhead can easily exceed the gain on
// a model this small. Selected per animal so the two can be compared in the same session.
let loadMujoco = null;
import { FlyAgent, PHASES, profStart, profStop, PROF } from './fly.js';
import { attachBrain, attachEyes } from '../brainsetup.js';
import { buildGroups, GroupMeter } from './groups.js';
import { RIGHT } from './motor.js';

let actPrev = null, actMapT = 0;
let graphRefs = null;
let fly = null, meter = null, running = false, speed = 1, others = [], env = null, lastReal = 0, simAhead = 0, timer = null;
let proxyIds = [], lastPose = -Infinity, loopActive = false;
const POSE_EVERY = 1000 / 30; // wall ms: twelve workers must not flood the render thread

onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    if (!loadMujoco) loadMujoco = (await (m.mt ? import('@mujoco/mujoco/mt') : import('@mujoco/mujoco'))).default;
    const mj = await loadMujoco();
    const g = m.graph;
    const data = { N: g.N, E: g.E, meta: m.meta, indptr: g.indptr, indices: g.indices, weights: g.weights, nt: g.nt, side: g.side, superclass: g.superclass, cls: g.cls };
    env = m.env;
    const brain = await attachBrain(m.wasmModule, m.brainMem, m.slot, data, 101 + m.id);
    const flyvis = m.brainMem.fv ? { eyes: attachEyes(brain.instance, m.brainMem, m.slot), map: m.flyvisMap, gain: 150 } : null;
    fly = new FlyAgent({ brain, flyvis, mj, flyXML: m.flyXML, env, data, size: g.size, sign: g.sign, bodymap: m.bodymap, gait: m.gait, id: m.id,
      pos: m.pos, yaw: m.yaw, nProxies: m.nProxies, mode: m.mode, brainOpts: m.brainOpts, vision: m.vision, neuromod: { calib: m.neuromod }, sex: m.sex, look: m.look, mushroom: m.mushroom, learn: m.learn, etaMul: m.etaMul, mbParams: m.mbParams, noci: m.noci, dnAll: m.dnAll });
    meter = new GroupMeter(buildGroups(m.bodymap, data.meta.types, data.side), g.N);
    // Views onto the shared connectome, for graph queries that are not part of stepping.
    {
      const buf = m.brainMem.memory.buffer;
      graphRefs = { N: g.N, E: g.E, types: data.meta.types,
                    indptr: new Uint32Array(buf, g.indptr, g.N + 1),
                    indices: new Uint32Array(buf, g.indices, g.E) };
    }
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
    postMessage({ type: 'ready', id: m.id, backend: fly.brain?.device ? 'WebGPU' : 'WASM', mt: !!m.mt, noci: fly.nociCounts || null, vpFix: fly.vpFix || null, dnAll: !!fly.motor?.useAllDN, dnN: fly.motor?.dnAllIdx?.length || 0, nbody: fly.model.nbody, bodyNames: [...Array(fly.model.nbody).keys()].map(i => fly.model.body(i).name), wingPoses: fly.flight.wingPoses(mj) });
    postPose();
    if (running) { lastReal = performance.now(); loop(); }
  // `loop` is now one long-lived async loop rather than a self-rescheduling timeout, so starting
  // it twice is prevented by `loopActive` inside it rather than by clearing a timer here.
  } else if (m.type === 'run') { if (running) return; running = true; lastReal = performance.now(); if (fly) loop(); }
  // The loop notices `running` at its next yield and exits on its own.
  else if (m.type === 'pause') { running = false; }
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
  // PUT A SAVED BRAIN BACK INTO A LIVE ANIMAL.
  //
  // The mirror of `exportmb`. Init could already accept `mbState`, but only at birth, so loading a
  // saved brain meant destroying the animal and building a new one. This applies it in place.
  //
  // It REPLIES, always, including when it refuses. A restore that silently does nothing looks
  // exactly like one that worked -- the page would report "loaded" and the animal would carry on
  // with the weights it already had.
  else if (m.type === 'restoremb') {
    let ok = false, why = 'no mushroom body in this animal';
    if (fly?.mb && m.mb) {
      const src = new Float32Array(m.mb);
      if (src.length === fly.mb.depress.length) { fly.mb.depress.set(src); fly.mb.dirty = true; ok = true; why = ''; }
      else why = `saved brain has ${src.length} edges, this index has ${fly.mb.depress.length}`;
    } else if (!m.mb) why = 'no weights supplied';
    postMessage({ type: 'mbrestored', id: fly?.id, ok, why, edges: fly?.mb?.depress.length || 0 });
  }
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
  else if (m.type === 'flip') {
    const d = fly.mjd, a = fly.jointAdr['free'];
    d.qpos[a + 2] = m.z ?? 0.30;                    // clear of the floor so it lands rather than clips
    d.qpos[a + 3] = 0; d.qpos[a + 4] = 1;           // quaternion (w,x,y,z) = 180 deg about x: supine
    d.qpos[a + 5] = 0; d.qpos[a + 6] = 0;
    for (let i = 0; i < d.qvel.length; i++) d.qvel[i] = 0;
    fly.mj.mj_forward(fly.model, d);
    fly.motor.righting = false; fly.motor.invertedMs = 0;   // start the reflex from a clean state
    fly.motor.pushSide = null;                              // and from an unlatched side -- see below
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
  else if (m.type === 'livestats') {
    const wall = performance.now() - (stats.t0 || performance.now());
    const known = stats.stepMs + stats.flushMs + stats.syncMs + stats.poseMs + stats.yieldMs;
    postMessage({ type: 'livestats', id: m.id, wall, simMs: stats.simMs, iters: stats.iters,
      stepMs: stats.stepMs, flushMs: stats.flushMs, syncMs: stats.syncMs, poseMs: stats.poseMs,
      yieldMs: stats.yieldMs, otherMs: wall - known,
      backend: fly?.brain?.device ? 'WebGPU' : 'WASM' });
    // The phase breakdown of the step itself, summed over the same window.
    const ph = PROF.on;
    if (ph) { const o = { steps: ph.steps, wall: performance.now() - ph.t0,
                          nRates: ph.nRates, nEye: ph.nEye, nChanged: ph.nChanged, nOverlap: ph.nOverlap, nSamp: ph.nSamp };
              for (const k of PHASES) o[k] = ph[k];
              postMessage({ type: 'phases', id: m.id, ph: o }); }
    if (m.reset) { statsReset(); profStart(); }
    if (m.profOff) profStop();
  }
  else if (m.type === 'profile') {
    const n = m.steps || 200;
    const t = { senses: 0, brain: 0, physics: 0, total: 0 };
    const F = fly, B = F.brain;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const a = performance.now();
      const st = F.state(); F.senses.update(st, F.env, 1);
      if (F.fv && (F.t % 20 === 0)) F.fv.update(() => {}, F.env, F.albedo, 20);
      const b = performance.now();
      B.step ? B.step(1) : null;
      if (B.flush) B.flush();
      const c = performance.now();
      for (let k = 0; k < F.physPerMs; k++) F.mj.mj_step(F.model, F.mjd);
      const d2 = performance.now();
      t.senses += b - a; t.brain += c - b; t.physics += d2 - c;
    }
    t.total = performance.now() - t0;
    postMessage({ type: 'profile', id: F.id, steps: n, ms: t,
                  physPerMs: F.physPerMs, timestep: F.model.opt.timestep,
                  backend: B.device ? 'WebGPU' : 'WASM', nSensory: F.driven.length });
  }
  else if (m.type === 'actmap') {
    const cnt = fly.brain.spikeCount, N = cnt.length;
    if (!actPrev || actPrev.length !== N) actPrev = new Uint32Array(N);
    const out = new Uint8Array(N);
    const dt = Math.max(1, fly.t - (actMapT || 0)); actMapT = fly.t;
    // spikes/s per neuron, mapped so that ~60 Hz saturates: above that the differences stop
    // mattering for a picture and the bright end would swallow everything else.
    const k = 255 / 60 * 1000 / dt;
    for (let i = 0; i < N; i++) {
      const d = cnt[i] - actPrev[i]; actPrev[i] = cnt[i];
      if (d > 0) { const v = d * k; out[i] = v > 255 ? 255 : v; }
    }
    postMessage({ type: 'actmap', id: fly.id, t: fly.t, act: out.buffer }, [out.buffer]);
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
    mn9: fly.motor.mean(fly.motor.muscles.find(x => x.name.startsWith('MN9'))?.idx || []), feeding: fly.motor.feeding(), heat: fly.heatFelt ?? st.heat ?? 0, heatFeet: fly.heatFeetFelt || 0, harm: fly.lastHarm || null, dbg: fly.intrinsic ? { toUntil: fly.intrinsic.takeoffUntil|0, t: fly.intrinsic.t|0, lastBurnFly: fly.intrinsic.lastBurnFly|0, hot: +(fly.intrinsic.hot||0).toFixed(3), pushSide: fly.motor.pushSide || null,
      urgentUntil: fly.intrinsic.urgentUntil|0, veto: fly.motor.jumpVeto || null, vetoT: fly.motor.jumpVetoT|0 } : null, song: fly.songHeard || 0, nSensory: fly.driven.length,
    foodEaten: fly.foodEaten.splice(0, fly.foodEaten.length, ...fly.foodEaten.map(() => 0)), behavior: fly.behavior(st), singing: !!fly.cmd?.singing, drive: fly.intrinsic?.label(), nm: fly.neuromod?.readout(), mb: fly.mb ? { warm: fly.mb._age > fly.mb.p.warmupMs, kc: +fly.mb.stats.kcDrive.toFixed(2), dan: +fly.mb.stats.danDrive.toFixed(2), edges: fly.mb.stats.edges, learning: fly.mb.dirty, depressed: fly.mb.stats.depressed, maxDep: +fly.mb.stats.maxDepress.toFixed(3), meanDep: +fly.mb.stats.meanDepress.toFixed(5), mbon: +fly.mb.stats.mbonDrive.toFixed(2), mExc: +fly.mb.stats.mbonExc.toFixed(2), mInh: +fly.mb.stats.mbonInh.toFixed(2), mAver: +fly.mb.stats.mbonAver.toFixed(2), mAppet: +fly.mb.stats.mbonAppet.toFixed(2), phasic: +fly.mb.stats.phasicMax.toFixed(4), peak: +fly.mb.stats.phasicPeak.toFixed(4), gate: +fly.mb.stats.gate.toFixed(3), popRel: +fly.mb.stats.popRel.toFixed(3), pop: +fly.mb.stats.pop.toFixed(2), popFast: +fly.mb.stats.popFast.toFixed(2), popBase: +fly.mb.stats.popBase.toFixed(2), popAv: +fly.mb.stats.popAv.toFixed(2), avRel: +fly.mb.stats.avRel.toFixed(3) } : null, flying: fly.flight.active, flights: fly.flights, dist: fly.dist, jumps: fly.jumps, pos: st.pos, up: +fly.mjd.xmat[fly.bid.thorax * 9 + 8].toFixed(3),
    roll: +fly.mjd.xmat[fly.bid.thorax * 9 + 7].toFixed(3), yaw: Math.atan2(fly.mjd.xmat[fly.bid.thorax * 9 + 3], fly.mjd.xmat[fly.bid.thorax * 9]) }, [p.xpos.buffer, p.xquat.buffer]);
}
// ---- THE LOOP, AND WHY IT USED TO SPEND MOST OF ITS TIME WAITING -------------------------------
//
// Measured: one simulated millisecond costs about 2.0 ms of work (physics 77%, senses 20%, brain
// 3%), which is 49.8% of real time. The loop delivered 0.8 to 3%. Stripping the renderer and every
// panel recovered only ~2 points, so the ~47 missing points were in here.
//
// Two causes, both about waiting rather than working:
//
//   1. `await device.queue.onSubmittedWorkDone()` ran EVERY iteration. That drains the GPU
//      pipeline and serialises CPU against GPU instead of letting them overlap. It exists for a
//      real reason -- an unbounded compute queue stalls WebGL and leaves the motor reading stale
//      brain state -- so it is kept, but as a periodic bound rather than a per-iteration stall.
//
//   2. `setTimeout(loop, 0)` reschedules itself, and browsers clamp nested timeouts to ~4 ms after
//      a few levels. With an 8 ms work budget that is up to a third of the time asleep. A
//      MessageChannel yields to the event loop without the clamp.
//
// The per-iteration budget is also raised: more work between yields amortises whatever fixed cost
// each yield carries. It stays bounded so the worker still returns to its message queue promptly --
// `pause`, `env` and `tune` must not wait on a long burst.
//
// GPU_SYNC_EVERY is a queue-depth bound, not a correctness requirement: the brain's own `flush()`
// still runs each iteration, and nothing reads GPU results synchronously between syncs.
const STEP_BUDGET_MS = 24;    // wall ms of stepping per iteration (was 8)
const STEP_BUDGET_N  = 64;    // simulated ms per iteration (was 8)
const GPU_SYNC_EVERY = 8;     // drain the queue this often, not every iteration

// A yield that does not clamp. setTimeout(0) from inside a timeout callback is throttled to ~4 ms
// by every browser after five nested levels; a MessageChannel message is not.
const yieldChan = new MessageChannel();
let yieldResolve = null;
yieldChan.port1.onmessage = () => { const r = yieldResolve; yieldResolve = null; r && r(); };
const yieldToEventLoop = () => new Promise(res => { yieldResolve = res; yieldChan.port2.postMessage(0); });

let gpuSyncCounter = 0;

// ---- WHERE THE WALL CLOCK ACTUALLY GOES ------------------------------------------------------
//
// Every previous profile of this simulation measured the WORK and missed the WAITING, and each time
// the answer came out roughly 15x better than the loop delivers. The `profile` message times
// `senses/brain/physics` with the GPU queue left in flight, so it reports what the CPU handed over,
// not what the frame cost.
//
// These accumulators are inside the live loop and partition the whole wall clock: every millisecond
// between `statsT0` and now lands in exactly one bucket, and whatever is left over is time this
// worker was not running at all -- message handling, GC, or the browser throttling us. `other` being
// large is itself the finding; it means the loop is not the thing to optimise.
const stats = { stepMs: 0, flushMs: 0, syncMs: 0, poseMs: 0, yieldMs: 0, simMs: 0, iters: 0, t0: 0 };
function statsReset() {
  stats.stepMs = stats.flushMs = stats.syncMs = stats.poseMs = stats.yieldMs = 0;
  stats.simMs = stats.iters = 0; stats.t0 = performance.now();
}

async function loop() {
  if (!running || loopActive) return;
  loopActive = true;
  if (!stats.t0) statsReset();
  try {
    while (running) {
      const now = performance.now();
      simAhead += Math.min(100, now - lastReal) * speed; lastReal = now;
      const t0 = performance.now(); let steps = 0;
      while (running && simAhead >= 1 && steps < STEP_BUDGET_N && performance.now() - t0 < STEP_BUDGET_MS) {
        fly.step(); simAhead -= 1; steps++;
      }
      const tStep = performance.now(); stats.stepMs += tStep - t0; stats.simMs += steps; stats.iters++;
      fly.brain.flush?.();
      const tFlush = performance.now(); stats.flushMs += tFlush - tStep;
      // Bound the queue rather than drain it every iteration, and always drain before stopping so
      // a paused animal is not left with work in flight.
      if (steps && fly.brain.device && (++gpuSyncCounter >= GPU_SYNC_EVERY || !running)) {
        gpuSyncCounter = 0;
        await fly.brain.device.queue.onSubmittedWorkDone();
      }
      const tSync = performance.now(); stats.syncMs += tSync - tFlush;
      if (simAhead > 50) simAhead = 50;   // can't keep up: run as fast as possible
      if (steps && (!running || performance.now() - lastPose >= POSE_EVERY)) postPose();
      const tPose = performance.now(); stats.poseMs += tPose - tSync;
      // Yield so the worker answers its message queue -- pause, env, tune must not wait on a burst.
      await yieldToEventLoop();
      stats.yieldMs += performance.now() - tPose;
    }
  } finally {
    // Cleared in `finally` so a throw inside the loop cannot leave the worker permanently unable to
    // start again: loopActive stuck true would make every later `run` a silent no-op.
    loopActive = false;
  }
}

// One embodied fly per worker: its own connectome brain + MuJoCo physics world.
import loadMujoco from '@mujoco/mujoco';
import { FlyAgent } from './fly.js';
import { attachBrain, attachEyes } from '../brainsetup.js';
import { buildGroups, GroupMeter } from './groups.js';

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
    postMessage({ type: 'ready', id: m.id, nbody: fly.model.nbody, bodyNames: [...Array(fly.model.nbody).keys()].map(i => fly.model.body(i).name), wingPoses: fly.flight.wingPoses(mj) });
    postPose();
    if (running) { lastReal = performance.now(); loop(); }
  } else if (m.type === 'run') { if (running) return; running = true; lastReal = performance.now(); clearTimeout(timer); if (fly) loop(); }   // before init: loop starts once ready; clearTimeout kills a pending reschedule from a paused loop
  else if (m.type === 'pause') { running = false; clearTimeout(timer); }
  else if (m.type === 'speed') speed = m.speed;
  else if (m.type === 'env') { Object.assign(env, m.env); fly.env = env; if (fly.foodEaten.length !== env.food.length) fly.foodEaten = env.food.map(() => 0); }
  else if (m.type === 'others') { others = m.others; fly.others = others; setProxies(); }
  else if (m.type === 'mode') fly.motor.mode = m.mode;
  // Janus restaging the arena changes what the surfaces reflect, so the flies' vision changes too.
  else if (m.type === 'look') { fly.look = m.look; fly.fv && (fly.fv.settled = false); }
  else if (m.type === 'stimulate') fly.brain.setDrive(m.indices, m.rate);
  else if (m.type === 'learn') { if (fly.mb) fly.mb.learn = !!m.on; }
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
    const want = m.geom || 'janus_geom';
    for (let g = 0; g < M.ngeom; g++) if (M.geom(g).name === want) gid = g;
    const jm = want === 'monster_geom' ? fly.monsterMocap : fly.janusMocap;
    postMessage({ type: 'probe', gid, kind: gid >= 0 ? fly.geomKind[gid] : null, mocapId: jm,
      mocapPos: [d.mocap_pos[jm*3], d.mocap_pos[jm*3+1], d.mocap_pos[jm*3+2]],
      geomPos: gid >= 0 ? [d.geom_xpos[gid*3], d.geom_xpos[gid*3+1], d.geom_xpos[gid*3+2]] : null,
      geom: want, envJanus: fly.env.janus, envMonster: fly.env.monster, albedo: gid >= 0 ? fly.albedo(gid, 0, 0) : null,
      nmocap: M.nmocap, hits: fly.fv ? (() => { const gv = fly.fv.gid.GetView(); let n = 0; for (let i = 0; i < gv.length; i++) if (gv[i] === gid) n++; return n; })() : 'no-fv' });
  }
  else if (m.type === 'takeoff') { fly.requestTakeoff(); postPose(); }
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
    mn9: fly.motor.mean(fly.motor.muscles.find(x => x.name.startsWith('MN9'))?.idx || []), feeding: fly.motor.feeding(), heat: st.heat || 0, nSensory: fly.driven.length,
    foodEaten: fly.foodEaten.splice(0, fly.foodEaten.length, ...fly.foodEaten.map(() => 0)), behavior: fly.behavior(st), singing: !!fly.cmd?.singing, drive: fly.intrinsic?.label(), nm: fly.neuromod?.readout(), mb: fly.mb ? { kc: +fly.mb.stats.kcDrive.toFixed(2), dan: +fly.mb.stats.danDrive.toFixed(2), edges: fly.mb.stats.edges, learning: fly.mb.dirty, depressed: fly.mb.stats.depressed, maxDep: +fly.mb.stats.maxDepress.toFixed(3), meanDep: +fly.mb.stats.meanDepress.toFixed(5), mbon: +fly.mb.stats.mbonDrive.toFixed(2), mExc: +fly.mb.stats.mbonExc.toFixed(2), mInh: +fly.mb.stats.mbonInh.toFixed(2), mAver: +fly.mb.stats.mbonAver.toFixed(2), mAppet: +fly.mb.stats.mbonAppet.toFixed(2), phasic: +fly.mb.stats.phasicMax.toFixed(4), peak: +fly.mb.stats.phasicPeak.toFixed(4), gate: +fly.mb.stats.gate.toFixed(3), popRel: +fly.mb.stats.popRel.toFixed(3), pop: +fly.mb.stats.pop.toFixed(2), popFast: +fly.mb.stats.popFast.toFixed(2), popBase: +fly.mb.stats.popBase.toFixed(2), popAv: +fly.mb.stats.popAv.toFixed(2), avRel: +fly.mb.stats.avRel.toFixed(3) } : null, flying: fly.flight.active, flights: fly.flights, dist: fly.dist, jumps: fly.jumps, pos: st.pos, yaw: Math.atan2(fly.mjd.xmat[fly.bid.thorax * 9 + 3], fly.mjd.xmat[fly.bid.thorax * 9]) }, [p.xpos.buffer, p.xquat.buffer]);
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

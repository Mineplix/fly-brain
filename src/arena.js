import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { loadCuticleDetail } from './fly-appearance.js';
import { loadBlenderFly, createBlenderFly, loadArenaDetail, blenderOutput } from './fly-blender.js';
import { ArenaBatches } from './arena-batches.js';
import { RenderResolution } from './render-resolution.js';
import { loadConnectome } from './data.js';
import { PRESETS } from './sim/world.js';
import { allocBrainMemory, MAX_FLIES } from './brainsetup.js';
import { parseFlyVis } from './flyvis.js';
import { buildGroups } from './sim/groups.js';
import { startRingmaster } from './ringmaster.js';
import * as store from './flystore.js';
import { buildMushroomIndex } from './sim/mushroom.js';
const BASE = import.meta.env.BASE_URL; // "/" in dev, "/fly-brain/" on GitHub Pages

const $ = s => document.querySelector(s);
const status = s => { const el = $('#status'); if (el) el.textContent = s; else console.info(s); };
const FLY_COLORS = ['#ffb347', '#5ac8fa', '#a3e635', '#f472b6', '#c084fc', '#facc15', '#fb7185', '#2dd4bf'];
const presetKey = new URLSearchParams(location.search).get('env') || 'foraging';
const PRESET = PRESETS[presetKey] || PRESETS.foraging;
// Worker-pool cap. Each fly is one worker doing its own brain + physics. Default 6, from the
// measured ramp on this machine (RTX 4050, WebGPU brain, rendering on): aggregate throughput
// saturates at ~3 flies and never exceeds ~0.16 sim-s per wall-s, so past that more flies only
// subdivide a fixed budget. 6 is the highest count that still holds a flat 165 fps, with
// aggregate within 6% of the maximum. ?flies=N overrides.
// Hard-limited by MAX_FLIES because the shared brain memory is sized for MAX_FLIES slots at
// load time (see allocBrainMemory) and cannot grow afterwards. Note that slots are never
// reclaimed (nothing calls worker.terminate), so this is a lifetime budget rather than a
// concurrency limit -- lowering it needs a page reload.
const FLY_LIMIT = 6;   // hard ceiling for this build, regardless of MAX_FLIES or ?flies=
const FLY_CAP = Math.min(FLY_LIMIT, MAX_FLIES, Math.max(1, Number(new URLSearchParams(location.search).get('flies')) || 6));
// ?vision=0 runs the flies blind: no eye raycasting (2 x 721 rays per fly per 20 ms) and no
// flyvis optic-lobe model. The ~62k optic-lobe neurons stay in the connectome and keep their
// chemical synapses -- they are simply never driven by light, so the fly navigates by smell,
// taste and touch alone. This is a behavioural change, not just an optimisation.
const NO_VISION = new URLSearchParams(location.search).get('vision') === '0';
// Mushroom-body plasticity. On by default; ?learn=0 gives a fixed-weight brain, which is what you
// want for a controlled behavioural comparison or a benchmark.
const LEARN = new URLSearchParams(location.search).get('learn') !== '0';
// ?eta=X scales the mushroom-body learning rate, for dose-response tests. If an effect is real
// it should grow with the dose; if it does not, it was not the learning producing it.
const ETA_MUL = Math.max(0, Number(new URLSearchParams(location.search).get('eta')) || 1);
// Phasic-dopamine gate threshold (MB_DEFAULTS.phasicFloor). Learning happens only while the
// smoothed DAN trace sits this far above its own slow baseline, which is what stops the rule
// depressing everything from the tonic level. The default was calibrated against a hot floor
// said to drive popRel to 0.27-0.34; measured in this build it rests at 0.002 and peaks at
// 0.111 under punishment, so 0.15 is unreachable. ?dafloor=X overrides it -- and any value
// used must be checked against an unpunished control, or it is not measuring learning.
// Nociceptive afferents onto PPL1 (senses.js bindNociceptors). OFF by default: it is an
// addition beyond the connectome, supplying afferents the EM volume does not contain, and any
// result that depends on it must say so. ?noci=1 to enable.
const NOCI_ON = new URLSearchParams(location.search).get('noci') === '1';
const DA_FLOOR_RAW = Number(new URLSearchParams(location.search).get('dafloor'));
const DA_FLOOR = Number.isFinite(DA_FLOOR_RAW) && DA_FLOOR_RAW >= 0 ? DA_FLOOR_RAW : null;
// Persistent flies. Each fly's learned mushroom-body weights are kept locally (IndexedDB,
// keyed by the fly's name) and restored next time the page opens, so the flies you had are
// the flies you get back rather than a fresh set of naive ones.
// ?persist=0 gives a clean, unsaved session -- which is what you want for a benchmark or a
// controlled run, since a fly that remembers the last experiment is not a naive subject.
let PERSIST = new URLSearchParams(location.search).get('persist') !== '0' && LEARN;
// Arena look. 'circus' is a big-top: black/white checker floor, red/yellow tent stripes,
// bunting, saturated props. 'lab' is the original muted tan/grey. ?theme=lab to switch back.
// This is NOT purely cosmetic: the floor and wall albedos in FlyAgent.albedo() are kept in
// step with these, so a higher-contrast arena drives the photoreceptors harder.
const THEME = new URLSearchParams(location.search).get('theme') === 'lab' ? 'lab' : 'circus';
const LOOKS = {
  circus: { floorA: '#132049', floorB: '#f0ede4', wallA: '#e02128', wallB: '#f6c624',
            prop: ['#21c8e4', '#ff4fa3', '#9ae62c', '#ff8a2b', '#a45cff', '#2bd9b0'],
            bunting: ['#21c8e4', '#ff4fa3', '#f6c624', '#9ae62c'], food: '#ffd84d', sky: '#1a0f1e',
            tent: true, props: true, stair: { x: -0.15, y: -0.15, color: '#e02128', pole: '#8e1118', dais: '#f6c624' },
            // relative luminance of the four surfaces above, handed to the flies' albedo()
            orb: '#ff2318', orbGlow: '#ff6a4a',
            // Rec.709 luma of the four surfaces above, on the sRGB bytes / 255. The navy floor
            // is 0.126 where the old near-black was 0.073, so the floor's contrast ratio falls
            // from ~13:1 to ~7:1 -- a real change to what the photoreceptors are handed, not a
            // repaint, which is why the number moves with the colour.
            albedo: { floorLo: 0.126, floorHi: 0.92, wallLo: 0.29, wallHi: 0.77 } },
  lab:    { floorA: '#6f6554', floorB: '#9c907a', wallA: '#2a2a2e', wallB: '#c9c9cf',
            prop: ['#3d4a3d'], bunting: null, food: '#f2c14e', sky: '#0b0e14',
            tent: false, stair: null, orb: '#ff2318', orbGlow: '#ff6a4a',
            albedo: { floorLo: 0.35, floorHi: 0.60, wallLo: 0.15, wallHi: 0.75 } },
  // Janus can restage the ring into any of these. Not decoration: `albedo` is handed to every
  // fly, so a dungeon really is darker to the flies than the big top, and switching sets the
  // optic lobe re-settling against the new scene rather than reading it as a sudden transient.
  dungeon: { floorA: '#2b2722', floorB: '#4a443b', wallA: '#1e1c22', wallB: '#38343c',
             prop: ['#5b5348', '#6b6257', '#43403a', '#514a40'],
             bunting: null, food: '#c9a227', sky: '#07070a',
             tent: false, stair: null, stage: 'dungeon', floor: 'slab', floorTile: 1.1, wall: 'blocks',
             albedo: { floorLo: 0.10, floorHi: 0.26, wallLo: 0.06, wallHi: 0.16 } },
  cavern:  { floorA: '#1d2b2a', floorB: '#30443f', wallA: '#14201f', wallB: '#24332f',
             prop: ['#3d5a52', '#2f4a44', '#4a6b5e'],
             bunting: null, food: '#7fe3c0', sky: '#04090b',
             tent: false, stair: null, stage: 'cavern', floor: 'mottle', floorTile: 0.9, wall: 'solid',
             albedo: { floorLo: 0.07, floorHi: 0.22, wallLo: 0.04, wallHi: 0.13 } },
  lab2:    { floorA: '#d8dce3', floorB: '#eef1f6', wallA: '#aeb6c2', wallB: '#ccd3dc',
             prop: ['#7f8c9b', '#9aa7b6'],
             bunting: null, food: '#ffd84d', sky: '#dfe5ee',
             tent: false, stair: null,
             albedo: { floorLo: 0.72, floorHi: 0.91, wallLo: 0.45, wallHi: 0.68 } },
  // ---- places Janus can send them. Albedos are Rec.709 luma of the colours above, /255, the
  // same convention the original four follow -- so a beach really is blinding to a fly and hell
  // really is near-dark, rather than being a repaint of the same reflectances.
  beach:   { floorA: '#cbb47e', floorB: '#e8d9a8', wallA: '#2f7fbf', wallB: '#7fd0f0',
             prop: ['#e8d9a8', '#c9b48a', '#ff8a2b', '#21c8e4'],
             bunting: null, food: '#ffd84d', sky: '#bfe4f5',
             tent: false, stair: null, stage: 'dunes', floor: 'speckle', floorTile: 0.5, wall: 'gradient',
             albedo: { floorLo: 0.710, floorHi: 0.850, wallLo: 0.449, wallHi: 0.757 } },
  field:   { floorA: '#4a7a35', floorB: '#7cb04f', wallA: '#8fbfe0', wallB: '#cfe9f7',
             prop: ['#6b4a2a', '#8a5a33', '#4f7a3a', '#c8d94a'],
             bunting: null, food: '#ffe66d', sky: '#a8d8f0',
             tent: false, stair: null, stage: 'meadow', floor: 'mottle', floorTile: 0.6, wall: 'gradient',
             albedo: { floorLo: 0.419, floorHi: 0.619, wallLo: 0.718, wallHi: 0.896 } },
  course:  { floorA: '#222831', floorB: '#e8eaed', wallA: '#1b2430', wallB: '#f6c624',
             prop: ['#f6c624', '#e02128', '#21c8e4', '#9ae62c'],
             bunting: null, food: '#ffd84d', sky: '#101722',
             tent: false, stair: null, stage: 'gauntlet', floor: 'checker', floorTile: 0.55, wall: 'solid',
             albedo: { floorLo: 0.154, floorHi: 0.917, wallLo: 0.137, wallHi: 0.771 } },
  heaven:  { floorA: '#efeade', floorB: '#ffffff', wallA: '#e3dcc4', wallB: '#fdfaf0',
             prop: ['#ffe9a8', '#ffffff', '#dfe9ff', '#f7e7b0'],
             bunting: null, food: '#ffe9a8', sky: '#eaf2ff',
             tent: false, stair: null, stage: 'clouds', floor: 'soft', floorTile: 1.6, wall: 'gradient',
             albedo: { floorLo: 0.918, floorHi: 1.000, wallLo: 0.862, wallHi: 0.980 } },
  hell:    { floorA: '#1a0a08', floorB: '#5a1a12', wallA: '#0e0604', wallB: '#7a1d10',
             prop: ['#ff4a1e', '#8e1118', '#3a1008', '#c2410c'],
             bunting: null, food: '#ff8a2b', sky: '#12050a',
             tent: false, stair: null, stage: 'brimstone', floor: 'cracked', floorTile: 0.9, wall: 'blocks',
             albedo: { floorLo: 0.052, floorHi: 0.153, wallLo: 0.030, wallHi: 0.188 } },
};
let LOOK = LOOKS[THEME] || LOOKS.circus;
// Ringmaster: narrates the flies and restages the arena between "adventures". On by default
// with the circus theme, off for 'lab'. ?ringmaster=0 / =1 forces it either way.
// ⚠️ It mutates env on a timer, so DISABLE IT FOR BENCHMARKS (?ringmaster=0) -- a run that
// changes the food, wind and light halfway through is not measuring one thing.
const RM_FLAG = new URLSearchParams(location.search).get('ringmaster');
const RINGMASTER = RM_FLAG === '1' || (RM_FLAG !== '0' && THEME === 'circus');
const env = PRESET.env();
// ?props=0 stages the ring with the staircase alone. Obstacles are baked into each fly's MuJoCo
// model by buildWorldXML at creation, so their cost can only be compared across separate page
// loads -- mutating env.obstacles afterwards changes sensing and the render, not physics.
const PROPS_ON = new URLSearchParams(location.search).get('props') !== '0';
/** 16 raised, rotated treads around a newel post: 30 degrees and 0.062 cm per step (~1.33 turns, ~1 cm tall). */
function spiralStaircase({ x, y, color, pole, dais }) {
  const N = 22, rise = 0.062, turn = Math.PI / 6, rHelix = 0.34, out = [];
  // a raised dais anchors the staircase to the middle of the ring instead of leaving it
  // floating on the floor, which is the single biggest staging difference in the reference
  if (dais) out.push({ type: 'cylinder', x, y, r: 0.62, sz: 0.045, color: dais });
  for (let k = 0; k < N; k++) {
    const th = k * turn;
    out.push({ type: 'box', x: x + rHelix * Math.cos(th), y: y + rHelix * Math.sin(th), z: 0.045 + k * rise,
      sx: 0.22, sy: 0.055, sz: 0.03, yaw: th, color });   // sx runs radially outward from the post
  }
  out.push({ type: 'cylinder', x, y, r: 0.06, sz: (N - 1) * rise + 0.12, z: 0.045, color: pole });
  return out;
}
/**
 * Carnival furniture: pedestal tables, stacked crates, a layered centrepiece and scattered
 * blocks, at a range of heights so there is something to climb rather than one empty ring.
 *
 * These are REAL obstacles, not scenery. Each becomes a collision geom in every fly's MuJoCo
 * world and is walked by clearance() on every sensory tick, so the count is a cost, not free
 * decoration -- which is the whole reason they are worth having: the flies can climb them, bump
 * into them, and be occluded by them.
 */
function carnivalProps(look) {
  const P = look.prop, out = [];
  const pick = i => P[i % P.length];
  // pedestal tables: a thin pole with a disc on top, the tall furniture the flies can perch on
  const tables = [[-1.55, 0.95, 0.52], [1.45, 1.05, 0.44], [1.75, -0.55, 0.60], [-1.15, -1.55, 0.40]];
  tables.forEach(([x, y, h], i) => {
    out.push({ type: 'cylinder', x, y, r: 0.045, sz: h, color: look.wallA });
    out.push({ type: 'cylinder', x, y, r: 0.20, sz: 0.035, z: h, color: pick(i) });
  });
  // stacked crates, offset so they read as stacked rather than as one tall box
  const stacks = [[0.95, -1.65], [-1.85, -0.35]];
  stacks.forEach(([x, y], i) => {
    out.push({ type: 'box', x, y, sx: 0.17, sy: 0.17, sz: 0.24, color: pick(i + 1) });
    out.push({ type: 'box', x: x + 0.05, y: y - 0.04, sx: 0.12, sy: 0.12, sz: 0.18, z: 0.24, color: pick(i + 3) });
  });
  // layered centrepiece: three discs of falling radius, the big cake on the left of the reference
  const cx = -1.7, cy = 1.75;
  [[0.42, 0.10, 0], [0.31, 0.09, 0.10], [0.20, 0.08, 0.19]].forEach(([r, h, z], i) =>
    out.push({ type: 'cylinder', x: cx, y: cy, r, sz: h, z, color: pick(i + 2) }));
  // low scattered blocks, the loose confetti of the set
  [[0.55, 0.95], [-0.45, -0.95], [1.15, 0.25], [-0.85, 0.35], [0.25, 1.65], [1.85, 1.65]]
    .forEach(([x, y], i) => out.push({ type: 'box', x, y, sx: 0.10, sy: 0.10, sz: 0.13 + 0.05 * (i % 3), color: pick(i) }));
  return out;
}

/**
 * Wall furniture: brackets and plaques mounted high on the stripes, as in the reference.
 *
 * Mounted just inside the wall and yawed to face the centre, so they protrude into the arena as
 * ledges a fly can land on rather than being flat decals. Real obstacles, like everything else
 * in here -- they occlude, they collide, and clearance() sees them.
 */
function wallProps(look, radius, wallHeight) {
  const P = look.prop, out = [];
  const N = 10, rIn = radius - 0.13;
  for (let k = 0; k < N; k++) {
    const th = (k + 0.5) / N * 2 * Math.PI;
    const x = rIn * Math.cos(th), y = rIn * Math.sin(th);
    // alternate a deep shelf and a shallow plaque so the ring is not a row of identical boxes
    const deep = k % 2 === 0;
    out.push({ type: 'box', x, y, yaw: th,
      sx: deep ? 0.10 : 0.05, sy: deep ? 0.20 : 0.26,
      sz: deep ? 0.05 : 0.14,
      z: wallHeight * (deep ? 0.62 : 0.70),
      color: P[k % P.length] });
  }
  return out;
}

/**
 * What each place is made of. A stage sets BOTH the furniture and the conditions, because a
 * location the flies only see is scenery -- a beach should be humid and bright, hell should be
 * hot and near-dark, and those reach the animal through hygrosensory, thermosensory and
 * photoreceptor channels that already exist.
 *
 * Obstacles are baked into each fly's MuJoCo model when the fly is built, so switching stage
 * goes through relocate(), which rebuilds the flies carrying their learned weights across.
 */
const STAGES = {
  // the big top, as before
  carnival(env, look) {
    Object.assign(env.arena, { shape: 'circle', radius: 2.5, wallHeight: 1.2 });
    env.obstacles.push(...spiralStaircase({ x: -0.15, y: -0.15, color: '#e02128', pole: '#8e1118', dais: '#f6c624' }));
    env.obstacles.push(...carnivalProps(look), ...wallProps(look, env.arena.radius, env.arena.wallHeight));
    env.light.sky = 1; env.humidity = 0.45; env.wind = [0, 0];
  },
  // low dunes and a couple of rocks; damp, bright, a steady onshore breeze
  dunes(env, look) {
    // a wide shallow shore: the wall drops to a dune ridge you can see over
    Object.assign(env.arena, { shape: 'circle', radius: 3.2, wallHeight: 0.35 });
    const P = look.prop;
    [[1.3, 0.9, 0.34], [-1.5, 0.6, 0.28], [0.4, -1.6, 0.40], [-0.9, -1.2, 0.24], [1.7, -0.9, 0.30]]
      .forEach(([x, y, r], i) => env.obstacles.push({ type: 'cylinder', x, y, r, sz: 0.06 + 0.04 * (i % 3), color: P[i % P.length] }));
    [[0.9, 0.2], [-0.3, 1.5]].forEach(([x, y], i) =>
      env.obstacles.push({ type: 'box', x, y, sx: 0.16, sy: 0.13, sz: 0.22, yaw: i, color: P[1] }));
    env.light.sky = 1.4; env.humidity = 0.85; env.wind = [7, 2];
    env.food = [{ x: 1.5, y: 1.4, r: 0.28, sugar: 1, bitter: 0, water: 0.9, amount: 6 }];
    env.odors = [{ x: 1.5, y: 1.4, odor: 'vinegar', strength: 0.9, sigma: 1.2 }];
    env.hazards = []; env.bitterPatches = [];
  },
  // open grass: almost nothing to hide behind, which makes it the expensive case for vision
  meadow(env, look) {
    // genuinely open ground -- no wall at all. clearance() reports Infinity, so nothing is
    // steering these flies but their own brains and the horizon.
    Object.assign(env.arena, { shape: 'circle', radius: 4.0, wallHeight: 0 });
    const P = look.prop;
    for (let k = 0; k < 9; k++) {
      const th = k * 2.4, r = 0.7 + (k % 3) * 0.5;
      env.obstacles.push({ type: 'cylinder', x: r * Math.cos(th), y: r * Math.sin(th),
        r: 0.02, sz: 0.5 + 0.25 * (k % 4), color: P[2] });          // grass stalks
    }
    env.light.sky = 1.25; env.humidity = 0.55; env.wind = [5, 3];
    env.food = [{ x: -1.4, y: 1.2, r: 0.3, sugar: 1, bitter: 0, water: 0.4, amount: 8 }];
    env.odors = [{ x: -1.4, y: 1.2, odor: 'vinegar', strength: 1, sigma: 1.5 }];
    env.hazards = []; env.bitterPatches = [];
  },
  // a gauntlet: staggered walls to squeeze past, a climb, and the reward at the far end
  gauntlet(env, look) {
    // a corridor, not a ring: staggered baffles down a long rectangle, reward at the end
    Object.assign(env.arena, { shape: 'rect', w: 1.1, h: 2.6, radius: 2.6, wallHeight: 1.0 });
    const P = look.prop;
    for (let k = 0; k < 5; k++) {
      const y = -2.0 + k * 1.0, off = (k % 2) ? 0.42 : -0.42;   // leave a gap on alternating sides
      env.obstacles.push({ type: 'box', x: off, y, sx: 0.66, sy: 0.06, sz: 0.55, color: P[k % P.length] });
    }
    for (let k = 0; k < 4; k++)                                  // a staircase of crates to climb
      env.obstacles.push({ type: 'box', x: 0.72, y: 2.1, sx: 0.12, sy: 0.12, sz: 0.10 + k * 0.09,
        z: k * 0.09, color: P[1] });
    env.light.sky = 1; env.humidity = 0.45; env.wind = [0, 0];
    env.food = [{ x: 0, y: 2.35, r: 0.22, sugar: 1, bitter: 0, water: 0.3, amount: 8 }];
    env.odors = [{ x: 0, y: 2.35, odor: 'vinegar', strength: 1.4, sigma: 2.2 }];
    env.hazards = []; env.bitterPatches = [];
  },
  // raised platforms, blinding light, food everywhere and nothing that hurts
  clouds(env, look) {
    // platforms over nothing: no wall, and the only solid ground above the floor
    Object.assign(env.arena, { shape: 'circle', radius: 3.0, wallHeight: 0 });
    const P = look.prop;
    [[0, 0, 0.55], [1.4, 0.9, 0.42], [-1.4, 0.7, 0.36], [0.8, -1.4, 0.48], [-1.1, -1.2, 0.30]]
      .forEach(([x, y, h], i) => {
        env.obstacles.push({ type: 'cylinder', x, y, r: 0.045, sz: h, color: P[3] });
        env.obstacles.push({ type: 'cylinder', x, y, r: 0.34, sz: 0.04, z: h, color: P[i % P.length] });
      });
    env.light.sky = 1.5; env.humidity = 0.5; env.wind = [0, 0];
    env.food = ring(5, 1.5, (x, y) => ({ x, y, r: 0.26, sugar: 1, bitter: 0, water: 0.5, amount: 9 }));
    env.odors = env.food.map(f => ({ x: f.x, y: f.y, odor: 'vinegar', strength: 0.8, sigma: 0.8 }));
    env.hazards = []; env.bitterPatches = [];
  },
  // jagged rock, near-dark, hot floor between the safe ground. heat 0.5 is the damage threshold:
  // full nociceptor drive without killing anything (FIELD-NOTES 21).
  brimstone(env, look) {
    // a pit: small and steep-sided, so there is nowhere far to run
    Object.assign(env.arena, { shape: 'circle', radius: 1.8, wallHeight: 2.2 });
    const P = look.prop;
    for (let k = 0; k < 7; k++) {
      const th = k * 0.92, r = 0.8 + (k % 3) * 0.45;
      env.obstacles.push({ type: 'box', x: r * Math.cos(th), y: r * Math.sin(th),
        sx: 0.12, sy: 0.10, sz: 0.30 + 0.18 * (k % 3), yaw: th, color: P[k % P.length] });
    }
    env.light.sky = 0.3; env.humidity = 0.12; env.wind = [2, -1];
    env.hazards = ring(4, 1.3, (x, y) => ({ x, y, r: 0.38, heat: 0.5 }));
    env.food = [{ x: 0, y: 0, r: 0.22, sugar: 1, bitter: 0, water: 0.2, amount: 5 }];
    env.odors = [{ x: 0, y: 0, odor: 'vinegar', strength: 1, sigma: 0.9 }];
    env.bitterPatches = [];
  },
  // the original underground rooms keep working
  dungeon(env, look) {
    // a square cell. A corner is a different navigational problem from a curve.
    Object.assign(env.arena, { shape: 'rect', w: 1.9, h: 1.9, radius: 1.9, wallHeight: 1.6 });
    env.obstacles.push(
      { type: 'cylinder', x: -0.8, y: 0.9, r: 0.16, sz: 0.9, color: look.prop[0] },
      { type: 'cylinder', x: 0.9, y: 0.8, r: 0.16, sz: 0.9, color: look.prop[1] },
      { type: 'cylinder', x: -0.9, y: -0.8, r: 0.16, sz: 0.9, color: look.prop[2] },
      { type: 'box', x: 0.4, y: -1.3, sx: 0.9, sy: 0.08, sz: 0.45, color: look.prop[3 % look.prop.length] });
    env.light.sky = 0.35; env.humidity = 0.45; env.wind = [0, 0];
    env.food = [{ x: 1.7, y: -1.5, r: 0.26, sugar: 1, bitter: 0, water: 0.3, amount: 6 }];
    env.odors = [{ x: 1.7, y: -1.5, odor: 'vinegar', strength: 1.2, sigma: 1.3 }];
    env.hazards = []; env.bitterPatches = [];
  },
  cavern(env, look) {
    Object.assign(env.arena, { shape: 'rect', w: 2.6, h: 1.5, radius: 2.6, wallHeight: 1.1 });
    env.obstacles.push(
      { type: 'cylinder', x: 0.2, y: 1.2, r: 0.22, sz: 0.7, color: look.prop[0] },
      { type: 'cylinder', x: -1.2, y: -0.3, r: 0.28, sz: 0.55, color: look.prop[1] });
    env.light.sky = 0.28; env.humidity = 0.9; env.wind = [2, 1];
    env.food = [{ x: -1.4, y: 1.3, r: 0.3, sugar: 1, bitter: 0, water: 0.9, amount: 6 }];
    env.odors = [{ x: -1.4, y: 1.3, odor: 'vinegar', strength: 1, sigma: 1.4 }];
    env.hazards = []; env.bitterPatches = [];
  },
};
const ring = (n, r, f) => Array.from({ length: n }, (_, k) => {
  const a = k / n * 2 * Math.PI; return f(r * Math.cos(a), r * Math.sin(a)); });

/** Wipe the arena and build the named place into `env`. Does NOT move any fly -- see relocate(). */
function stageInto(env, name) {
  const look = LOOKS[name] || LOOKS[THEME] || LOOKS.circus;
  env.obstacles = []; env.hazards = []; env.bitterPatches = [];
  const fn = STAGES[look.stage || (name === 'circus' ? 'carnival' : null)];
  if (fn) fn(env, look); else { env.light.sky = 1; env.humidity = 0.45; env.wind = [0, 0]; }
  return look;
}

// ?where=<place> starts somewhere other than the theme's own staging: beach, field, course,
// heaven, hell, dungeon, cavern. Janus can move them later with relocate().
//
// This runs HERE, below STAGES, and not up with the other flags: stageInto() is a hoisted
// function declaration but STAGES is a const, so calling it any earlier throws a ReferenceError
// from the temporal dead zone -- which breaks the whole page before it loads anything.
const WHERE_RAW = new URLSearchParams(location.search).get('where');
const WHERE = LOOKS[WHERE_RAW] ? WHERE_RAW : null;
if (WHERE) { LOOK = LOOKS[WHERE]; stageInto(env, WHERE); }
else if (PROPS_ON) stageInto(env, THEME);
else if (LOOK.stair) env.obstacles.push(...spiralStaircase(LOOK.stair));   // bare ring, for benchmarks

const flies = [];          // {id, worker, group, bodies[], last, color, ready}
let mushroom = null;
let flyvisMap, shared, meta, bodymap, flyXML, gait, visual, batches, outputPass, running = false, selected = 0, tool = 'none', speed = 2, brainMem, wasmModule, brainParams, neuromodCalib;

function toShared(ta) { const sab = new SharedArrayBuffer(ta.byteLength); const out = new ta.constructor(sab); out.set(ta); return out; }

async function main() {
  if (!crossOriginIsolated) console.warn('not cross-origin isolated: SharedArrayBuffer unavailable');
  const data = await loadConnectome(status);
  meta = data.meta;
  status('loading body model');
  const [bm, xml, g, blender, levels, output, sz, sg, bp, wasmBytes, fvb, fvj, fvi, fvm, nmc, detail] = await Promise.all([
    fetch(`${BASE}data/bodymap.json`).then(r => r.json()), fetch(`${BASE}body/fly_physics.xml`).then(r => r.text()), fetch(`${BASE}body/gait.json`).then(r => r.json()),
    loadBlenderFly(BASE, status), loadArenaDetail(BASE), blenderOutput(BASE),
    fetch(`${BASE}data/neuron_size.bin`).then(r => r.arrayBuffer()), fetch(`${BASE}data/ntsign.bin`).then(r => r.arrayBuffer()),
    fetch(`${BASE}data/brain_params.json`).then(r => r.ok ? r.json() : {}).catch(() => ({})), fetch(`${BASE}lif.wasm`).then(r => r.arrayBuffer()),
    fetch(`${BASE}vision/flyvis.bin`).then(r => r.arrayBuffer()), fetch(`${BASE}vision/flyvis.json`).then(r => r.json()), fetch(`${BASE}vision/flyvis_inputs.json`).then(r => r.json()), fetch(`${BASE}vision/flyvis_map.json`).then(r => r.json()),
    fetch(`${BASE}data/neuromod.json`).then(r => r.ok ? r.json() : null).catch(() => null), loadCuticleDetail(`${BASE}body/cuticle_detail.png`)]);
  // Passing null here also skips the sensoryMask that would otherwise zero these neurons'
  // incoming synapses (allocBrainMemory marks flyvis-driven neurons sensory because flyvis
  // normally replaces their input). Blind flies therefore keep an intact, wired optic lobe.
  const vision = NO_VISION ? null : { model: parseFlyVis(fvb, fvj, fvi), map: fvm };
  bodymap = bm; flyXML = xml; gait = g; visual = createBlenderFly(blender, detail, levels); outputPass = output;
  shared = { N: data.N, E: data.E, indptr: toShared(data.indptr), indices: toShared(data.indices), weights: toShared(data.weights), nt: toShared(data.nt),
    side: toShared(data.side), superclass: toShared(data.superclass), cls: toShared(data.cls), size: toShared(new Float32Array(sz)), sign: toShared(new Float32Array(sg)) };
  brainParams = { ...bp, neuromod: !!(bp.neuromod && nmc) };
  if (new URLSearchParams(location.search).get('gpu') === '0') brainParams.gpu = false;   // ?gpu=0 forces the WASM kernel
  neuromodCalib = nmc; wasmModule = await WebAssembly.compile(wasmBytes);
  status('writing connectome into shared memory');
  status('writing connectome and optic-lobe model into shared memory');
  brainMem = allocBrainMemory({ ...data, superclass: data.superclass }, shared.size, shared.sign, brainParams, MAX_FLIES, vision);
  flyvisMap = fvm;
  // Plastic KC->MBON slice (0.4% of the graph). Built once here because it needs the effective
  // post-writeGraph weights; shared read-only with every worker, which keeps its own depression map.
  mushroom = buildMushroomIndex(data, brainMem.memory, brainMem.graph);
  console.info(`mushroom body: ${mushroom.nKC} KCs -> ${mushroom.nEdges} plastic KC->MBON edges`);
  window.__data = data;
  buildBrainPanel(data);
  buildScene(data);
  buildUI();
  $('#loading').remove();
  const st0 = PRESET.start || [0, 0, 0];
  // Last session's flies come back first, with the brains they learned. Only if there are none
  // saved do we fall back to the preset's naive starting cast.
  // One tab owns the saved flies; a second tab of the same app runs read-only so the two
  // cannot overwrite each other's animals on their autosave timers.
  if (PERSIST && !await store.claimStore()) {
    PERSIST = false;
    console.warn('[flystore] another tab already owns the saved flies -- persistence off for this tab.');
  }
  const restored = await restoreFlies();
  if (!restored) {
    if (PRESET.flySpots) for (const s of PRESET.flySpots.slice(0, FLY_CAP)) await addFly(s.pos, s.yaw, s.sex);
    else { await addFly([st0[0], st0[1]], st0[2]);
      for (let k = 1; k < Math.min(PRESET.flies || 1, FLY_CAP); k++) { const ang = k * 2.4; await addFly([1.2 * Math.cos(ang), 1.2 * Math.sin(ang)], ang + Math.PI); } }
  }
  startAutosave();
  startOrbTicker();
  if (PRESET.autoThreat) setInterval(() => { if (!running || !flies.length) return; const live = flies.filter(f => f.last?.alive !== false); if (!live.length) return; selected = live[Math.floor(Math.random() * live.length)].id; launchThreat(); }, PRESET.autoThreat * 1000);
  window.__arena = { camera, controls, flies, env, THREE, renderer, scene, gtao, composer, metrics, resolution, batches, visual, addFly, removeFly, renameFly, rebuildEnv, launchThreat, janusSpeak, setLook, LOOKS, relocate, stageInto, theme: THEME, releaseMonster, recallMonster, store, saveAllFlies, saveFlyRecord, PERSIST, FLY_CAP, MAX_FLIES,
    orbDebug: () => ({ presence: orbPresence, glow: orbGlow, until: orbUntil, now: performance.now(), out: orbWasOut, spokeAt: orbSpokeAt }) };
  animate();
  if (RINGMASTER) {
    window.__ringmaster = startRingmaster(window.__arena);
    // ?stage=<words> hands Janus a command as soon as the arena is up, so a single URL opens
    // straight into a scene: ?stage=monster, ?stage=dungeon, ?stage=lava, and so on. Same
    // parser as the command box, so anything you can type, you can link to.
    const stage = new URLSearchParams(location.search).get('stage');
    if (stage) setTimeout(() => window.__ringmaster.command(stage), 2500);
  }
}

// ---------------- scene ----------------
let renderer, scene, camera, controls, envGroup, raycaster, floorMesh, sun, hemi, rimLight, composer, gtao, resolution;
let shadowDirty = true, lastShadow = -Infinity, shadowExtent = 0, lastBrainDraw = 0, brainDirty = true;
let brainColorFly = -1, brainColorHover = -2;
const shadowCenter = new THREE.Vector3(Infinity, Infinity, Infinity), viewPoint = new THREE.Vector3();
const viewFrustum = new THREE.Frustum(), viewProjection = new THREE.Matrix4(), flyBounds = new THREE.Sphere(new THREE.Vector3(), 0.24);
const metrics = { calls: 0, triangles: 0, renderMs: 0, shadowUpdates: 0, brainUploads: 0, brainDraws: 0 };
let brainRenderer, brainScene, brainCam, brainPts, brainAct;
function buildScene(data) {
  renderer = new THREE.WebGLRenderer({ canvas: $('#c'), antialias: false, powerPreference: 'high-performance' });
  resolution = new RenderResolution(() => resize(), { targetFps: 120 });
  renderer.setPixelRatio(resolution.ratio); renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; renderer.shadowMap.autoUpdate = false;
  renderer.info.autoReset = false;
  scene = new THREE.Scene(); scene.background = new THREE.Color(LOOK.sky);
  scene.matrixAutoUpdate = false;
  const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, 0.04).texture; scene.environmentIntensity = 0.24;
  room.dispose(); pmrem.dispose();
  camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.005, 100); camera.up.set(0, 0, 1);
  camera.position.set(-1.2, -1.6, 1.3);
  controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.target.set(0, 0, 0.1);
  controls.minDistance = 0.16; controls.maxDistance = env.arena.radius * 5;
  // Lighting belongs to the PLACE, not to the app: a big top is flat and bright, a pit is dark
  // and red, a beach is blown out. applyLighting() is re-run whenever the place changes.
  // Render-only -- the flies' albedo blocks are untouched, so lighting the set for us never
  // quietly changes what the photoreceptors are handed.
  hemi = new THREE.HemisphereLight('#ffffff', '#6b6f86', 0.85);
  scene.add(hemi);
  sun = new THREE.DirectionalLight('#ffffff', 1.9); sun.position.set(3, 2, 8); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.00002; sun.shadow.normalBias = 0.0003; sun.shadow.radius = 2;
  Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.1, far: 20 }); scene.add(sun, sun.target);
  rimLight = new THREE.DirectionalLight('#ffffff', 1.0); rimLight.position.set(-3, -2, 3); scene.add(rimLight);
  applyLighting(LOOK);
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  composer = new EffectComposer(renderer, rt); composer.addPass(new RenderPass(scene, camera));
  gtao = new GTAOPass(scene, camera, 1, 1);
  gtao.updateGtaoMaterial({ radius: 0.012, distanceExponent: 1.5, thickness: 0.6, scale: 1, samples: 8 });
  // Cycles already baked body/hair occlusion. Keep the ground contact shadow; skip redundant AO.
  gtao.enabled = false; composer.addPass(gtao); composer.addPass(outputPass);
  // Only solid cuticle/environment surfaces belong in AO. Films, plume overlays and subpixel hairs do not.
  const override = gtao._renderOverride, hidden = [];
  gtao._renderOverride = function (...args) {
    scene.traverseVisible(o => { if (o.isMesh && (o.isInstancedMesh || o.material.transparent)) { hidden.push(o); o.visible = false; } });
    try { return override.apply(this, args); } finally { for (const o of hidden) o.visible = true; hidden.length = 0; }
  };
  function resize() {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setPixelRatio(resolution.ratio); renderer.setSize(innerWidth, innerHeight);
    composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(innerWidth, innerHeight);
    gtao.setSize(Math.ceil(innerWidth * renderer.getPixelRatio() / 2), Math.ceil(innerHeight * renderer.getPixelRatio() / 2));
    shadowDirty = true;
  }
  addEventListener('resize', () => { resolution.reset(); resize(); }); resize();
  envGroup = new THREE.Group(); scene.add(envGroup); rebuildEnv();
  batches = new ArenaBatches(scene, visual, MAX_FLIES);
  raycaster = new THREE.Raycaster();
  renderer.domElement.addEventListener('pointerdown', e => { pd = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', e => { if (pd && Math.hypot(e.clientX - pd[0], e.clientY - pd[1]) < 4) onClick(e); });
  // brain inset: soma point cloud colored by activity of the selected fly
  const bw = $('#brain').clientWidth || 358, bh = $('#brain').clientHeight || 220;
  brainRenderer = new THREE.WebGLRenderer({ canvas: $('#brain'), antialias: false, alpha: true }); brainRenderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  brainRenderer.setSize(bw, bh, false);
  brainScene = new THREE.Scene(); brainCam = new THREE.PerspectiveCamera(40, bw / bh, 1, 20000);
  const pos = new Float32Array(data.N * 3), col = new Float32Array(data.N * 3); const c = new THREE.Vector3(); let n = 0;
  for (let i = 0; i < data.N; i++) { const x = data.soma[i * 3]; if (!Number.isFinite(x)) { pos[i * 3] = 1e6; continue; } pos[i * 3] = x * 8e-3; pos[i * 3 + 1] = data.soma[i * 3 + 1] * 8e-3; pos[i * 3 + 2] = data.soma[i * 3 + 2] * 8e-3; c.x += pos[i * 3]; c.y += pos[i * 3 + 1]; c.z += pos[i * 3 + 2]; n++; }
  c.divideScalar(n); for (let i = 0; i < data.N; i++) { pos[i * 3] -= c.x; pos[i * 3 + 1] -= c.y; pos[i * 3 + 2] -= c.z; col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0.12; }
  const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); bg.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  brainPts = new THREE.Points(bg, new THREE.PointsMaterial({ size: 1.3, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false }));
  brainPts.rotation.x = Math.PI; brainScene.add(brainPts);
  hlPts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, transparent: true, opacity: 1, depthWrite: false, depthTest: false }));
  hlPts.visible = false; brainScene.add(hlPts);
  brainCam.position.set(0, 0, 1050); brainCam.lookAt(0, 0, 0); brainAct = new Float32Array(data.N);
  buildStack(data);
}

// ---------------- neural stack: every fly's brain at once ----------------
// One renderer, one shared position buffer, and a per-fly colour buffer swapped in before each
// row is drawn -- so a fly's colours are uploaded only when its trace arrives, not every frame.
// Somas are subsampled (STACK_STRIDE) because each row is ~84 px tall and 165k points into that
// is wasted bandwidth.
let stackRenderer, stackScene, stackCam, stackPts, stackIdx = null;
const stackCols = [];                 // per fly: THREE.BufferAttribute of colours
const STACK_STRIDE = 2, STACK_ROW = 84;
// Resting neurons are near-black, not dim green: ~82k points in an 84 px row overlap heavily,
// and with normal (non-additive) blending a green resting colour fills the whole silhouette,
// leaving spikes with nowhere to stand out. REST keeps just enough tint to read the outline.
const REST = [0.010, 0.026, 0.018], SPAN = [0.36, 0.97, 0.43];
let stackRows = -1, stackSpin = 0;
function buildStack(data) {
  const keep = [];
  for (let i = 0; i < data.N; i += STACK_STRIDE) if (Number.isFinite(data.soma[i * 3])) keep.push(i);
  stackIdx = Int32Array.from(keep);
  const n = stackIdx.length, pos = new Float32Array(n * 3); const c = new THREE.Vector3();
  for (let k = 0; k < n; k++) { const i = stackIdx[k];
    pos[k * 3] = data.soma[i * 3] * 8e-3; pos[k * 3 + 1] = data.soma[i * 3 + 1] * 8e-3; pos[k * 3 + 2] = data.soma[i * 3 + 2] * 8e-3;
    c.x += pos[k * 3]; c.y += pos[k * 3 + 1]; c.z += pos[k * 3 + 2]; }
  c.divideScalar(n);
  for (let k = 0; k < n; k++) { pos[k * 3] -= c.x; pos[k * 3 + 1] -= c.y; pos[k * 3 + 2] -= c.z; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));   // placeholder, swapped per row
  stackPts = new THREE.Points(g, new THREE.PointsMaterial({ size: 1, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.92, depthWrite: false }));
  stackPts.rotation.x = Math.PI;
  stackScene = new THREE.Scene(); stackScene.add(stackPts);
  stackCam = new THREE.PerspectiveCamera(40, 1, 1, 20000); stackCam.position.set(0, 0, 1080); stackCam.lookAt(0, 0, 0);
  stackRenderer = new THREE.WebGLRenderer({ canvas: $('#stackCanvas'), antialias: false, alpha: true });
  stackRenderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  stackRenderer.autoClear = false; stackRenderer.setScissorTest(true);   // many viewports, one canvas
}
/** allocate a colour buffer for a newly spawned fly, at its resting (unspiked) colour */
function stackAddFly(i) {
  if (!stackIdx || stackCols[i]) return;
  const a = new Float32Array(stackIdx.length * 3);
  for (let k = 0; k < stackIdx.length; k++) { a[k * 3] = REST[0]; a[k * 3 + 1] = REST[1]; a[k * 3 + 2] = REST[2]; }
  stackCols[i] = new THREE.BufferAttribute(a, 3).setUsage(THREE.DynamicDrawUsage);
}
/** write one fly's spike trace into its colour buffer: near-black at rest -> bright green when firing */
function stackTrace(i, trace) {
  const attr = stackCols[i]; if (!attr || !stackIdx) return;
  const a = attr.array, idx = stackIdx;
  for (let k = 0; k < idx.length; k++) {
    const t = Math.min(1, trace[idx[k]] * 1.6);
    const v = t * t * (3 - 2 * t);   // smoothstep: crushes the decaying tail, keeps fresh spikes bright
    a[k * 3] = REST[0] + v * SPAN[0]; a[k * 3 + 1] = REST[1] + v * SPAN[1]; a[k * 3 + 2] = REST[2] + v * SPAN[2];
  }
  attr.needsUpdate = true;
}
/** free a deleted fly's colour buffer so the slot starts clean when reused */
function stackRemoveFly(slot) { stackCols[slot] = null; stackRows = -1; }

let stackLabelKey = '';
function stackLabels(force = false) {
  const key = flies.map(f => f.id + f.name).join(',') + ':' + selected;   // renderFlyList also ticks every 500 ms; don't wipe the live Hz readouts
  if (!force && key === stackLabelKey) return;
  stackLabelKey = key;
  const host = $('#stLabels'); host.innerHTML = '';
  flies.forEach((f, i) => {
    const d = document.createElement('div'); d.className = 'r' + (f.id === selected ? ' sel' : '');
    d.style.top = (i * STACK_ROW) + 'px';
    d.innerHTML = `<b>${f.name}</b><i style="background:${f.color}"></i><span class="hz"></span>`;
    host.appendChild(d);
  });
  $('#stCount').textContent = flies.length + (flies.length === 1 ? ' fly' : ' flies');
  $('#stack').hidden = flies.length === 0;
}
function drawStack() {
  const n = flies.length; if (!stackRenderer || !n || $('#stack').hidden) return;
  const wrap = $('#stWrap'), w = Math.max(1, wrap.clientWidth), h = n * STACK_ROW;
  if (stackRows !== n || stackRenderer.domElement.width === 0) {
    $('#stackCanvas').style.height = h + 'px'; stackRenderer.setSize(w, h, false);
    stackCam.aspect = w / STACK_ROW; stackCam.updateProjectionMatrix(); stackRows = n;
  }
  stackSpin += 0.005; stackPts.rotation.y = stackSpin;
  stackRenderer.setViewport(0, 0, w, h); stackRenderer.setScissor(0, 0, w, h); stackRenderer.clear();   // setViewport takes CSS px; three applies the pixel ratio
  for (let i = 0; i < n; i++) {
    const col = stackCols[flies[i].slot]; if (!col) continue;   // keyed by slot: array position shifts on delete
    stackPts.geometry.setAttribute('color', col);
    const y = h - (i + 1) * STACK_ROW;          // three's viewport origin is bottom-left; rows read top-down
    stackRenderer.setViewport(0, y, w, STACK_ROW); stackRenderer.setScissor(0, y, w, STACK_ROW);
    stackRenderer.render(stackScene, stackCam);
  }
  metrics.brainDraws += n;
}
let pd = null;
function discMesh(r, color, opacity = 1, z = 0.0015) { const m = new THREE.Mesh(new THREE.CircleGeometry(r, 48), new THREE.MeshStandardMaterial({ color, transparent: opacity < 1, opacity, roughness: 0.8 })); m.position.z = z; m.receiveShadow = true; return m; }
/**
 * Ground texture. A checkerboard is a circus floor; a beach is not tiled and a cavern is not
 * either. `floorA`/`floorB` stay the two extremes whatever the pattern, so the albedo block the
 * flies are handed still brackets what is drawn -- the pattern changes the arrangement, not the
 * reflectance range.
 */
function floorTexture(look) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const x = cv.getContext('2d'), A = look.floorA, B = look.floorB;
  const rnd = (seed => () => (seed = seed * 1664525 + 1013904223 >>> 0) / 4294967296)(7);
  switch (look.floor || 'checker') {
    case 'speckle':      // sand: base tone, grains of the other
      x.fillStyle = B; x.fillRect(0, 0, 128, 128);
      x.fillStyle = A;
      for (let i = 0; i < 2600; i++) x.fillRect(rnd() * 128 | 0, rnd() * 128 | 0, 1, 1);
      x.globalAlpha = 0.35;
      for (let i = 0; i < 40; i++) { x.beginPath(); x.ellipse(rnd() * 128, rnd() * 128, 6 + rnd() * 14, 2 + rnd() * 4, rnd() * 3.14, 0, 6.283); x.fill(); }
      x.globalAlpha = 1;
      break;
    case 'mottle':       // grass, rock: irregular patches, no grid
      x.fillStyle = A; x.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 260; i++) {
        x.fillStyle = rnd() < 0.5 ? B : A; x.globalAlpha = 0.25 + rnd() * 0.6;
        x.beginPath(); x.ellipse(rnd() * 128, rnd() * 128, 3 + rnd() * 13, 3 + rnd() * 9, rnd() * 3.14, 0, 6.283); x.fill();
      }
      x.globalAlpha = 1;
      break;
    case 'slab':         // flagstones: big blocks with mortar lines, offset per row
      x.fillStyle = A; x.fillRect(0, 0, 128, 128);
      x.fillStyle = B;
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++)
        x.fillRect(c * 32 + (r % 2 ? 16 : 0) + 1.5, r * 32 + 1.5, 29, 29);
      break;
    case 'soft':         // heaven: almost uniform, the faintest drift
      x.fillStyle = B; x.fillRect(0, 0, 128, 128);
      x.fillStyle = A; x.globalAlpha = 0.25;
      for (let i = 0; i < 26; i++) { x.beginPath(); x.ellipse(rnd() * 128, rnd() * 128, 14 + rnd() * 30, 10 + rnd() * 22, 0, 0, 6.283); x.fill(); }
      x.globalAlpha = 1;
      break;
    case 'cracked':      // hell: dark ground split by glowing seams
      x.fillStyle = A; x.fillRect(0, 0, 128, 128);
      x.strokeStyle = B; x.lineWidth = 2.2;
      for (let i = 0; i < 9; i++) {
        x.beginPath(); let px = rnd() * 128, py = rnd() * 128; x.moveTo(px, py);
        for (let k = 0; k < 5; k++) { px += (rnd() - 0.5) * 46; py += (rnd() - 0.5) * 46; x.lineTo(px, py); }
        x.stroke();
      }
      break;
    default:             // checker: the big top
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
        x.fillStyle = ((i + j) & 1) ? B : A; x.fillRect(i * 64, j * 64, 64, 64);
      }
  }
  return cv;
}

/** Wall texture. Vertical stripes are a big top; masonry, sea and sky are not. */
function wallTexture(look) {
  const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 64;
  const x = cv.getContext('2d'), A = look.wallA, B = look.wallB;
  const rnd = (seed => () => (seed = seed * 1103515245 + 12345 >>> 0) / 4294967296)(11);
  switch (look.wall || 'stripes') {
    case 'gradient': {   // sea or sky: a band that darkens downward
      const g = x.createLinearGradient(0, 0, 0, 64);
      g.addColorStop(0, B); g.addColorStop(1, A); x.fillStyle = g; x.fillRect(0, 0, 1024, 64);
      x.globalAlpha = 0.16; x.fillStyle = B;                       // a little swell
      for (let i = 0; i < 90; i++) x.fillRect(rnd() * 1024, 26 + rnd() * 34, 12 + rnd() * 40, 1.5);
      x.globalAlpha = 1;
      break;
    }
    case 'blocks': {     // masonry, courses offset row to row
      x.fillStyle = A; x.fillRect(0, 0, 1024, 64);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 32; c++) {
        x.fillStyle = rnd() < 0.5 ? B : A;
        x.globalAlpha = 0.55 + rnd() * 0.45;
        x.fillRect(c * 32 + (r % 2 ? 16 : 0) + 1, r * 16 + 1, 30, 14);
      }
      x.globalAlpha = 1;
      break;
    }
    case 'solid':
      x.fillStyle = A; x.fillRect(0, 0, 1024, 64);
      x.globalAlpha = 0.2; x.fillStyle = B;
      for (let i = 0; i < 60; i++) x.fillRect(rnd() * 1024, rnd() * 64, 20 + rnd() * 60, 3);
      x.globalAlpha = 1;
      break;
    default:             // stripes
      for (let k = 0; k < 24; k++) { x.fillStyle = (k & 1) ? B : A; x.fillRect(k * 1024 / 24, 0, 1024 / 24 + 1, 64); }
  }
  return cv;
}

// sky tint, ground bounce, fill strength, key strength, rim strength
const LIGHTS = {
  circus:  { sky: '#ffffff', ground: '#6b6f86', fill: 0.85, key: 1.9,  rim: 1.00, keyCol: '#ffffff', rimCol: '#ffffff' },
  beach:   { sky: '#ffffff', ground: '#d9c9a0', fill: 1.25, key: 2.6,  rim: 0.85, keyCol: '#fff6e0', rimCol: '#cfe8ff' },
  field:   { sky: '#eaf6ff', ground: '#6f9a4a', fill: 1.00, key: 2.3,  rim: 0.70, keyCol: '#fff8e6', rimCol: '#cfe8ff' },
  course:  { sky: '#ffffff', ground: '#2a3340', fill: 0.60, key: 2.2,  rim: 0.90, keyCol: '#ffffff', rimCol: '#f6c624' },
  heaven:  { sky: '#ffffff', ground: '#e8eeff', fill: 1.45, key: 1.6,  rim: 1.20, keyCol: '#fffdf4', rimCol: '#e8f0ff' },
  hell:    { sky: '#3a1008', ground: '#6b1408', fill: 0.55, key: 0.85, rim: 0.75, keyCol: '#ff5a2a', rimCol: '#ff2d10' },
  dungeon: { sky: '#8fa0b8', ground: '#2a2620', fill: 0.35, key: 1.5,  rim: 0.45, keyCol: '#ffe6b8', rimCol: '#7fa8d8' },
  cavern:  { sky: '#9fd8cc', ground: '#16201f', fill: 0.35, key: 1.2,  rim: 0.50, keyCol: '#cfeee2', rimCol: '#4f8f7f' },
  lab:     { sky: '#f4f2ed', ground: '#514432', fill: 0.22, key: 2.7,  rim: 0.65, keyCol: '#fff1da', rimCol: '#f9e5c4' },
  lab2:    { sky: '#ffffff', ground: '#c9d2dd', fill: 1.10, key: 2.0,  rim: 0.80, keyCol: '#ffffff', rimCol: '#ffffff' },
};
/** Point the rig at a place. Called at build and on every relocation. */
function applyLighting(look) {
  const name = Object.keys(LOOKS).find(k => LOOKS[k] === look) || THEME;
  const L = LIGHTS[name] || LIGHTS.circus;
  if (hemi) { hemi.color.set(L.sky); hemi.groundColor.set(L.ground); hemi.intensity = L.fill; }
  if (sun) { sun.color.set(L.keyCol); sun.intensity = L.key; }
  if (rimLight) { rimLight.color.set(L.rimCol); rimLight.intensity = L.rim; }
  shadowDirty = true;
}

function rebuildEnv() {
  // Placement rebuilds own their resources; release old GPU buffers/textures before replacing them.
  envGroup.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose(); } });
  envGroup.clear(); shadowDirty = true;
  const A = env.arena, rect = A.shape === 'rect';
  const W = rect ? A.w : A.radius, H = rect ? A.h : A.radius, R = A.radius, wh = A.wallHeight;
  // floor: same 0.4 cm checker the flies' eyes see
  const cv = floorTexture(LOOK); const cx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const tile = LOOK.floorTile ?? 0.8;
  tex.repeat.set((W + 0.2) * 2 / tile, (H + 0.2) * 2 / tile);
  tex.magFilter = THREE.LinearFilter; tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); tex.colorSpace = THREE.SRGBColorSpace;
  floorMesh = new THREE.Mesh(
    rect ? new THREE.PlaneGeometry((W + 0.1) * 2, (H + 0.1) * 2) : new THREE.CircleGeometry(R + 0.1, 96),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  floorMesh.receiveShadow = true; envGroup.add(floorMesh);
  // striped wall (24 stripes), matching the visual environment used for the compound eye
  if (wh > 0) {
    const wt = new THREE.CanvasTexture(wallTexture(LOOK)); wt.colorSpace = THREE.SRGBColorSpace;
    if (rect) {
      const mat = new THREE.MeshStandardMaterial({ map: wt, side: THREE.BackSide, roughness: 0.9 });
      const sides = [[W * 2, 0, H, 0], [W * 2, 0, -H, Math.PI], [H * 2, W, 0, -Math.PI / 2], [H * 2, -W, 0, Math.PI / 2]];
      for (const [len, x, y, rot] of sides) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(len, wh), mat);
        m.position.set(x, y, wh / 2); m.rotation.set(Math.PI / 2, 0, rot, 'ZXY');
        m.lookAt(0, 0, wh / 2); m.rotateX(Math.PI / 2);
        envGroup.add(m);
      }
    } else {
      const wall = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.05, R + 0.05, wh, 96, 1, true), new THREE.MeshStandardMaterial({ map: wt, side: THREE.BackSide, roughness: 0.9 }));
      wall.rotation.x = Math.PI / 2; wall.position.z = wh / 2; envGroup.add(wall);
    }
  }
  if (LOOK.bunting && !rect) addBunting(R, wh);
  if (LOOK.tent && !rect) addTentCeiling(R, wh);
  for (const [i, o] of env.obstacles.entries()) { const m = new THREE.Mesh(o.type === 'box' ? new THREE.BoxGeometry(o.sx * 2, o.sy * 2, o.sz) : new THREE.CylinderGeometry(o.r, o.r, o.sz, 32), new THREE.MeshStandardMaterial({ color: o.color || LOOK.prop[i % LOOK.prop.length], roughness: 0.45, metalness: 0.05 }));
    if (o.type !== 'box') m.rotation.x = Math.PI / 2; else if (o.yaw) m.rotation.z = o.yaw;
    m.position.set(o.x, o.y, (o.z || 0) + o.sz / 2); m.castShadow = m.receiveShadow = true; envGroup.add(m); }
  for (const f of env.food) { const m = discMesh(f.r, LOOK.food, 0.35 + 0.65 * Math.min(1, f.amount / 5)); m.position.set(f.x, f.y, 0.002); m.userData.food = f; envGroup.add(m); }
  for (const b of env.bitterPatches) { const m = discMesh(b.r, '#4f8fd6', 0.9); m.position.set(b.x, b.y, 0.002); envGroup.add(m); }
  for (const h of env.hazards) { const m = discMesh(h.r, '#d9502f', 0.9); m.position.set(h.x, h.y, 0.002); envGroup.add(m); const glow = discMesh(h.r + 0.4, '#d9502f', 0.12, 0.001); glow.position.set(h.x, h.y, 0.001); envGroup.add(glow); }
  for (const o of env.odors) { // plume as a soft radial gradient
    const g = document.createElement('canvas'); g.width = g.height = 128; const gx = g.getContext('2d'); const grd = gx.createRadialGradient(64, 64, 0, 64, 64, 64);
    // Faint, and never larger than the ground it sits on. At 0.45 alpha and sigma*2.2 this
    // overlay covered an entire small arena in green -- it read as the floor colour rather than
    // as a plume, and cost real time to diagnose twice.
    const col = o.odor === 'co2' ? '120,200,255' : '190,255,120';
    grd.addColorStop(0, `rgba(${col},0.18)`); grd.addColorStop(0.55, `rgba(${col},0.07)`); grd.addColorStop(1, `rgba(${col},0)`);
    gx.fillStyle = grd; gx.fillRect(0, 0, 128, 128);
    const pr = Math.min(o.sigma * 2.2, Math.max(W, H) * 0.8);
    const m = new THREE.Mesh(new THREE.CircleGeometry(pr, 48), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(g), transparent: true, depthWrite: false }));
    m.position.set(o.x, o.y, 0.004); envGroup.add(m); }
}
// Circus bunting: a ring of triangular pennants hanging just below the top of the wall.
// Drawn as one alpha-cut texture on a short cylinder band rather than N triangle meshes,
// so it costs a single draw call and never shows up in the shadow or AO passes.
function addBunting(R, wallHeight) {
  const N = 32, W = 1024, H = 64, band = Math.min(0.26, wallHeight * 0.22);
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const step = W / N;
  for (let k = 0; k < N; k++) {
    g.fillStyle = LOOK.bunting[k % LOOK.bunting.length];
    const x = k * step;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x + step, 0); g.lineTo(x + step / 2, H * 0.82); g.closePath(); g.fill();
  }
  g.fillStyle = '#2a1520'; g.fillRect(0, 0, W, H * 0.09);   // the cord they hang from
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.03, R + 0.03, band, 96, 1, true),
    new THREE.MeshStandardMaterial({ map: t, side: THREE.BackSide, transparent: true, alphaTest: 0.5, roughness: 0.75 }));
  m.rotation.x = Math.PI / 2; m.position.z = wallHeight - band / 2 - 0.02; envGroup.add(m);
}
// Big-top canopy: an open cone sitting on the wall top, striped with the same 24-wedge texture
// as the wall so the panels line up. Purely visual -- flight cruises at 0.35-0.75 cm (FLIGHT.alt)
// against a 1.2 cm wall, so nothing ever reaches it and it needs no collision geom. It must not
// cast shadows either, or it would black out the arena it is lighting.
function addTentCeiling(R, wallHeight) {
  const rise = R * 0.72;
  const c = document.createElement('canvas'); c.width = 1024; c.height = 8; const g = c.getContext('2d');
  for (let k = 0; k < 24; k++) { g.fillStyle = (k & 1) ? LOOK.wallB : LOOK.wallA; g.fillRect(k * 1024 / 24, 0, 1024 / 24 + 1, 8); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(R + 0.05, rise, 96, 1, true),
    new THREE.MeshStandardMaterial({ map: t, side: THREE.BackSide, roughness: 0.95 }));
  cone.rotation.x = Math.PI / 2;                  // three's cone is +Y up; this scene is Z-up
  cone.position.z = wallHeight + rise / 2;
  cone.castShadow = false; cone.receiveShadow = false;
  envGroup.add(cone);
}
function buildFlyMesh(color, sex) {
  const appearance = visual.instantiate(sex);
  // Fine ground marker leaves the legs and contact shadow readable at macro scale.
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.175, 0.177, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false }));
  scene.add(ring);
  return { ...appearance, ring };
}

// One instanced draw per wing film across the sampled beat cycle. Poses are thorax-local and immutable.
const blurMaterial = new THREE.MeshStandardMaterial({ color: '#c0c7ce', transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide, roughness: 0.35 });
blurMaterial.forceSinglePass = true;
function buildWingBlur(f, poses) {
  if (!poses) return;
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1);
  f.wingBlur = ['left', 'right'].map(sd => {
    const src = f.bodies[`wing_${sd}`]; if (!src) return null;
    const film = f.meshes.find(m => m.name === `wing_${sd}_membrane`);
    const blur = new THREE.InstancedMesh(film.userData.low, blurMaterial, poses[sd].length);
    poses[sd].forEach((p, k) => { position.set(p[0], p[1], p[2]); rotation.set(p[4], p[5], p[6], p[3]); blur.setMatrixAt(k, matrix.compose(position, rotation, scale)); });
    blur.computeBoundingSphere(); blur.visible = false; blur.renderOrder = 2; f.bodies.thorax.add(blur);
    return { src, blur };
  });
}
function updateWingBlur(f, s) {
  if (!f.wingBlur) return;
  for (const w of f.wingBlur) if (w) { w.src.visible = !s.flying; w.blur.visible = !!s.flying; }
}

// ---------------- flies ----------------
// Slot pool. A slot is an index into brainMem.bases (and the flyvis eye blocks), allocated at
// load time for MAX_FLIES. Slots used to be handed out by an ever-incrementing counter, so a
// deleted fly's slot was lost forever; they are now recycled. Reuse is safe because both brain
// backends clear their state on construction -- LIFWasm.reset() in its constructor, and LIFGpu
// allocates fresh buffers -- and FlyVis rewrites v from bias.
let nextSlot = 0;
const freeSlots = [];
const takeSlot = () => (freeSlots.length ? freeSlots.shift() : nextSlot++);

/**
 * @param {object} [saved] a record from flystore: name, colour, sex and the learned
 *   mushroom-body weights of a fly from a previous session. Passing it restores that animal
 *   rather than creating a naive one.
 */
async function addFly(pos, yaw, sex = 'm', saved = null) {
  // No alert() here: addFly is called programmatically by the measurement harnesses, and an
  // alert() blocks a headless renderer forever. The UI button reports the cap itself.
  if (flies.length >= FLY_CAP) { console.warn(`[flies] cap reached: ${FLY_CAP}`); status(`Fly limit reached: ${FLY_CAP}.`); return; }
  const id = takeSlot();
  const color = saved?.color || FLY_COLORS[id % FLY_COLORS.length];
  if (saved?.sex) sex = saved.sex;
  const name = saved?.name || await uniqueFlyName(id);
  const worker = new Worker(new URL('./sim/fly.worker.js', import.meta.url), { type: 'module' });
  const f = { id, slot: id, name, worker, color, sex, ready: false, last: null, prev: null, stats: {},
    createdAt: saved?.createdAt || Date.now(), restored: !!saved?.mb, stale: !!saved?.stale, ...buildFlyMesh(color, sex) };
  scene.add(f.group); flies.push(f); batches.add(f); stackAddFly(id); eyeAddFly(f);
  worker.onmessage = e => onWorker(f, e.data);
  worker.postMessage({ type: 'init', id, graph: shared, meta, bodymap, flyXML, gait, env, pos, yaw, nProxies: MAX_FLIES - 1, mode: $('#mode').value, brainOpts: brainParams, neuromod: neuromodCalib, vision: !NO_VISION, sex, look: LOOK.albedo,
    brainMem: { memory: brainMem.memory, graph: brainMem.graph, bases: brainMem.bases, opts: brainMem.opts, fv: brainMem.fv }, wasmModule, slot: id, flyvisMap, mushroom, learn: LEARN, etaMul: ETA_MUL, noci: NOCI_ON, mbParams: DA_FLOOR === null ? null : { phasicFloor: DA_FLOOR },
    mbState: saved?.mb || null, restore: saved ? { energy: saved.energy, health: saved.health } : null },
    saved?.mb ? [saved.mb] : []);
  await new Promise(res => { f.onReady = res; });
  if (running) worker.postMessage({ type: 'run' });
  worker.postMessage({ type: 'speed', speed });
  if (PERSIST) saveFlyRecord(f, { force: true });
  renderFlyList();
  return f;
}

/** "Fly 3", or "Fly 3 (2)" if a saved fly already owns that name. Names key the store. */
/**
 * A name no live fly AND no saved record already owns.
 *
 * Checking only the live flies is a data-loss bug: slots are recycled, and restoreFlies() loads
 * at most FLY_CAP of however many are saved, so "Fly 3" can easily be free on screen while a
 * saved Fly 3 still holds a trained brain. addFly() force-saves immediately, so the new naive
 * animal would overwrite that brain without a word.
 */
async function uniqueFlyName(id, sex = 'm') {
  const taken = new Set(flies.map(x => x.name));
  if (PERSIST) { try { for (const r of await store.listFlies()) taken.add(r.name); } catch { /* store unreadable: live names are still better than nothing */ } }
  // the default name carries the sex, so two saved records are told apart at a glance
  const stem = sex === 'f' ? `Fly ${id} ♀` : `Fly ${id}`;
  let n = stem;
  for (let k = 2; taken.has(n); k++) n = `${stem} (${k})`;
  return n;
}

/** Remove a fly for good: kill its worker, free its GPU/CPU resources and recycle its slot. */
/**
 * Tear a fly down: kill its worker, free its GPU/CPU resources, recycle its slot.
 * @param {boolean} forget also delete its saved brain. FALSE when relocating -- the animal is
 *   being rebuilt elsewhere and its record must survive the teardown.
 */
function teardownFly(id, forget) {
  const i = flies.findIndex(f => f.id === id);
  if (i < 0) return false;
  const f = flies[i];
  f.worker.terminate();                       // nothing else stops the sim loop inside it
  batches.remove(f);
  scene.remove(f.group); scene.remove(f.ring);
  f.ring.geometry.dispose(); f.ring.material.dispose();
  f.group.traverse(o => { if (o.isMesh) { o.geometry?.dispose(); if (o.material !== f.ring.material) o.material?.dispose?.(); } });
  flies.splice(i, 1);
  freeSlots.push(f.slot);
  stackRemoveFly(f.slot); eyeRemoveFly(f.id);
  if (selected === id) selected = flies[0]?.id ?? -1;
  shadowDirty = true; batches.dirty = true;
  broadcastOthers(true);                      // stop the survivors sensing a ghost proxy
  renderFlyList(); stackLabels(true); eyeLabels();
  if (forget) {
    if (PERSIST) store.deleteFly(f.name).catch(e => console.warn('[flystore] delete failed', e));
    window.__ringmaster?.say(`${f.name} has left the circus. Do not ask where.`, { priority: 2 });
  }
  return true;
}
/** Remove a fly for good -- its saved brain goes with it. */
function removeFly(id) { return teardownFly(id, true); }

/**
 * Move every fly to another place.
 *
 * Obstacles are compiled into each fly's MuJoCo model by buildWorldXML when the fly is built, so
 * a new location cannot be applied to a running world -- repainting alone would leave the flies
 * colliding with furniture they can no longer see. Each animal is therefore rebuilt in the new
 * world, carrying its learned mushroom-body weights across through the same path the save/restore
 * machinery uses. The fly that arrives is the fly that left, memories included.
 *
 * @param {string} name a key of LOOKS
 * @returns {Promise<boolean>}
 */
async function relocate(name) {
  if (!LOOKS[name] || relocating) return false;
  relocating = true;
  try {
    // 1. take each animal with us: weights, identity, condition
    const party = [];
    for (const f of flies) {
      const m = await requestMB(f);
      party.push({ name: f.name, color: f.color, sex: f.sex, createdAt: f.createdAt,
        mb: m?.mb || null, energy: m?.energy, health: m?.health, mbSig: MB_SIG() });
    }
    // 2. restage: surfaces, furniture, light, humidity, wind, food, hazards
    LOOK = stageInto(env, name);
    if (scene) scene.background = new THREE.Color(LOOK.sky);
    applyLighting(LOOK);
    // 3. empty the ring, keeping every saved brain intact
    for (const f of [...flies]) teardownFly(f.id, false);
    rebuildEnv();
    // 4. rebuild each animal in the new world, weights and all
    const A = env.arena, rect = A.shape === 'rect';
    for (const [k, p] of party.entries()) {
      const a = k / Math.max(1, party.length) * 2 * Math.PI;
      // drop them inside the new ground, whatever shape it is
      const pos = rect ? [Math.cos(a) * A.w * 0.5, Math.sin(a) * A.h * 0.5]
                       : [Math.cos(a) * A.radius * 0.45, Math.sin(a) * A.radius * 0.45];
      await addFly(pos, a + Math.PI, p.sex, p);
    }
    shadowDirty = true;
    return true;
  } finally { relocating = false; }
}
let relocating = false;

function renameFly(id, name) {
  const f = flies.find(x => x.id === id);
  if (!f) return false;
  const was = f.name;
  const want = String(name).trim().slice(0, 24) || `Fly ${id}`;
  if (want !== was && flies.some(x => x !== f && x.name === want)) {
    console.warn(`[flies] "${want}" is already in the ring.`);
    status(`"${want}" is already in the ring.`);
    return false;
  }
  f.name = want;
  // The name is the key its brain is filed under, so renaming the fly renames its record.
  // renameStored refuses if the target name already belongs to a SAVED fly; force-saving after
  // that refusal would overwrite that fly's brain with this one's, so the rename is reverted
  // instead. Losing a trained animal to a name clash is worse than refusing the rename.
  if (PERSIST && want !== was) store.renameStored(was, want)
    .then(r => {
      if (r === 'ok') return;
      if (r === 'absent') { saveFlyRecord(f, { force: true }); return; }   // nothing saved yet: file it now
      // 'taken': another SAVED fly owns this name. Undo rather than overwrite its brain.
      f.name = was;
      renderFlyList(); stackLabels(true); eyeLabels();
      console.warn(`[flystore] "${want}" belongs to a saved fly; rename undone so its brain survives.`);
      status(`"${want}" belongs to a saved fly — rename undone.`);
    })
    .catch(e => console.warn('[flystore] rename failed', e));
  renderFlyList(); stackLabels(true); eyeLabels();
  if (id === selected) $('#bpTitle').innerHTML = `Inside ${f.name} <i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${f.color}"></i>`;
  return true;
}
function onWorker(f, m) {
  if (m.type === 'mb') { f.mbPending?.get(m.token)?.(m); f.mbPending?.delete(m.token); return; }
  if (m.type === 'ready') { f.ready = true; f.bodyNames = m.bodyNames; f.bodyGroups = m.bodyNames.map(n => f.bodies[n] || null); buildWingBlur(f, m.wingPoses); f.onReady?.(); }
  else if (m.type === 'pose') {
    f.prev = f.last; f.last = m; shadowDirty = true;
    const received = performance.now(); f.poseInterval = f.recvAt ? Math.max(16, Math.min(100, received-f.recvAt)) : 1000/30; f.recvAt = received;
    m.foodEaten?.forEach((d, k) => { if (d > 0 && env.food[k]) { env.food[k].amount = Math.max(0, env.food[k].amount - d); foodDirty = true; } });
    if (f.id === selected && (f.prev?.takeoffPending !== m.takeoffPending || f.prev?.flying !== m.flying)) renderFlyList();
    broadcastOthers();
  } else if (m.type === 'activity') {
    stackTrace(f.slot, m.trace);           // every fly feeds its own stack row
    const k = flies.indexOf(f);
    const row = $('#stLabels')?.children[k]?.querySelector('.hz');
    if (row) row.textContent = (m.groups.reduce((s, x) => s + x, 0) / m.groups.length).toFixed(1) + ' Hz';
    drawEyes(f, m.eyes);                   // every fly draws its own eye row
    if (f.id === selected && (f.activityTime !== m.t || histFly !== f.id)) {   // the selected fly also drives the big inset
      f.activityTime = m.t; brainAct.set(m.trace); brainDirty = true; onActivity(f, m);
    }
  }
}
let foodDirty = false, lastOthers = 0;
function broadcastOthers(force = false) {
  const now = performance.now(); if (!force && now - lastOthers < 1000 / 30) return; lastOthers = now;
  const poses = flies.filter(o => o.last && o.last.alive !== false).map(o => ({ id:o.id, x:o.last.pos[0], y:o.last.pos[1], z:o.last.pos[2], yaw:o.last.yaw, sex:o.sex, singing:!!o.last.singing }));
  for (const f of flies) if (f.ready) f.worker.postMessage({ type:'others', others:poses.filter(o => o.id !== f.id) });
}
function syncEnv() { for (const f of flies) if (f.ready) f.worker.postMessage({ type: 'env', env }); }

// ---------------- UI ----------------
function buildUI() {
  $('#play').onclick = () => { running = !running; for (const f of flies) f.worker.postMessage({ type: running ? 'run' : 'pause' }); $('#play').textContent = running ? '❚❚ Pause' : '▶ Run'; };
  const spawnAt = () => { const a = Math.random() * Math.PI * 2, r = Math.random() * env.arena.radius * 0.6; return [[r * Math.cos(a), r * Math.sin(a)], Math.random() * Math.PI * 2]; };
  // The name is asked for up front because it is the key this fly's saved brain is filed
  // under; renaming later moves the record, but naming it now is what you actually want.
  // Both spawn buttons run this. They differ only in `sex`, which is easy to lose sight of once
  // both show the same prompt -- so the prompt and the default name now say which is which.
  // Sex is not cosmetic: it selects the female cuticle materials, hides the sex comb, and is sent
  // to the worker, where it decides who courts whom.
  const spawnNamed = async sex => {
    if (flies.length >= FLY_CAP) { alert(`Fly limit reached: ${FLY_CAP}. Delete one first.`); return; }
    const [pos, yaw] = spawnAt();
    const label = sex === 'f' ? 'female' : 'male';
    let name = null;
    if (PERSIST) {
      name = prompt(`Name this ${label} fly (${sex === 'f' ? '♀' : '♂'}) — its brain is saved under this name:`,
        await uniqueFlyName(nextSlot, sex));
      if (name === null) return;
      name = String(name).trim().slice(0, 24);
      if (flies.some(x => x.name === name)) { alert(`"${name}" is already in the ring. Pick another name.`); return; }
      const existing = name ? await store.loadFly(name, MB_SIG()) : null;
      if (existing && !confirm(`"${name}" already has a saved brain (${(existing.simMs / 1000).toFixed(0)} s of experience). Bring that fly back?`)) return;
      if (existing) { await addFly(pos, yaw, existing.sex || sex, existing); return; }
    }
    await addFly(pos, yaw, sex, name ? { name, sex } : null);
  };
  $('#addFly').onclick = () => spawnNamed('m');
  $('#addFemale').onclick = () => spawnNamed('f');
  $('#importFly').hidden = !PERSIST;
  $('#importFly').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async ev => {
    const file = ev.target.files?.[0]; ev.target.value = '';
    if (!file) return;
    try {
      const rec = await store.decodeFly(file);
      if (flies.some(x => x.name === rec.name)) { alert(`"${rec.name}" is already in the ring.`); return; }
      if (rec.mb && rec.mbSig !== MB_SIG()) {
        if (!confirm(`"${rec.name}" was saved against a different mushroom-body index (${rec.mbSig}, this build is ${MB_SIG()}). Its learned weights cannot be applied. Add it naive?`)) return;
        rec.mb = null;
      }
      await store.saveFly(rec);
      const a = Math.random() * Math.PI * 2, r = Math.random() * env.arena.radius * 0.6;
      await addFly([r * Math.cos(a), r * Math.sin(a)], Math.random() * Math.PI * 2, rec.sex || 'm', rec);
    } catch (e) { alert(`Could not read that file: ${e.message}`); }
  };
  $('#speed').oninput = e => { speed = +e.target.value; $('#speedv').textContent = speed.toFixed(2) + '×'; for (const f of flies) f.worker.postMessage({ type: 'speed', speed }); };
  $('#preset').innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}" ${k === presetKey ? 'selected' : ''}>${p.label}</option>`).join('');
  $('#preset').onchange = e => { location.search = '?env=' + e.target.value; };
  $('#mode').onchange = e => { for (const f of flies) f.worker.postMessage({ type: 'mode', mode: e.target.value }); };
  document.querySelectorAll('.tools button').forEach(b => b.onclick = () => { tool = b.dataset.tool; document.querySelectorAll('.tools button').forEach(x => x.classList.toggle('on', x === b)); });
  setupFolds();
  // Each activity reply carries the full 165k-neuron trace (~660 kB), so polling every fly at
  // this rate would multiply the message traffic by the fly count. Instead poll round-robin:
  // total traffic stays one message per tick as before. The selected fly takes every other
  // slot so the big inset stays responsive; the rest share the remainder.
  let pollTurn = 0;
  setInterval(() => {
    if (document.hidden || $('#brainpanel').classList.contains('folded')) return;
    const ready = flies.filter(x => x.ready); if (!ready.length) return;
    const sel = ready.find(x => x.id === selected);
    const f = (sel && (pollTurn & 1)) ? sel : ready[(pollTurn >> 1) % ready.length];
    pollTurn++;
    f.worker.postMessage({ type: 'activity' });
  }, 120);
  $('#wind').oninput = e => { const v = +e.target.value; $('#windv').textContent = v; env.wind = [v, 0]; syncEnv(); };
  $('#light').oninput = e => { env.light.sky = +e.target.value; scene.background = new THREE.Color().setHSL(0.6, 0.3, 0.02 + 0.05 * env.light.sky); syncEnv(); };
  const sendCmd = () => { const v = $('#jcmd').value; if (!v.trim()) return;
    if (!window.__ringmaster) { alert('Janus is not running (?ringmaster=1 to enable).'); return; }
    window.__ringmaster.command(v); $('#jcmd').value = ''; };
  $('#jgo').onclick = sendCmd;
  $('#jcmd').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); sendCmd(); } };
  $('#janussec').hidden = !RINGMASTER;
  $('#threat').onclick = () => launchThreat();
  $('#takeoff').onclick = () => flies.find(x => x.id === selected)?.worker.postMessage({ type: 'takeoff' });
  setInterval(() => { if (foodDirty) { foodDirty = false; syncEnv(); envGroup.children.forEach(m => { if (m.userData.food) m.material.opacity = 0.35 + 0.65 * Math.min(1, m.userData.food.amount / 5); }); } renderFlyList(); }, 500);
}
function onClick(e) {
  const m = new THREE.Vector2(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); raycaster.setFromCamera(m, camera);
  // select a fly?
  for (const f of flies) { const hit = raycaster.intersectObjects(f.meshes.filter(m => m.parent.visible), false); if (hit.length) { selected = f.id; renderFlyList(); return; } }
  if (tool === 'none') return;
  const hit = raycaster.intersectObject(floorMesh); if (!hit.length) return; const p = hit[0].point;
  if (tool === 'food') { env.food.push({ x: p.x, y: p.y, r: 0.25, sugar: 1, bitter: 0, water: 0.2, amount: 5 }); env.odors.push({ x: p.x, y: p.y, odor: 'vinegar', strength: 0.8, sigma: 0.7 }); }
  if (tool === 'odor') env.odors.push({ x: p.x, y: p.y, odor: 'vinegar', strength: 1, sigma: 0.9 });
  if (tool === 'co2') env.odors.push({ x: p.x, y: p.y, odor: 'co2', strength: 1, sigma: 0.8 });
  if (tool === 'bitter') env.bitterPatches.push({ x: p.x, y: p.y, r: 0.25, bitter: 1 });
  if (tool === 'hazard') env.hazards.push({ x: p.x, y: p.y, r: 0.3, heat: 1 });
  if (tool === 'obstacle') { alert('Obstacles change the physics world; they apply to flies added after this point.'); env.obstacles.push({ type: 'box', x: p.x, y: p.y, sx: 0.2, sy: 0.2, sz: 0.3 }); }
  rebuildEnv(); syncEnv();
}
function renderFlyList() {
  stackLabels();
  $('#nfly').textContent = flies.length;
  $('#flies').innerHTML = flies.map(f => { const s = f.last || {}; const e = s.energy ?? 0, h = s.health ?? 1;
    return `<div class="fly ${f.id === selected ? 'sel' : ''}" data-id="${f.id}"><i class="dot" style="background:${f.color}"></i>
      <div>${f.sex === 'f' ? '♀' : '♂'} ${f.name} <span style="color:var(--acc)">${s.behavior || ''}</span><div class="bar"><i style="width:${e * 100}%;background:#f2c14e"></i></div><div class="bar"><i style="width:${h * 100}%;background:#4ade80"></i></div></div>
      <span class="flyact">${PERSIST ? `<button class="mini exp" title="Save this fly's brain to a file">⇩</button>` : ''}<button class="mini ren" title="Rename">✎</button><button class="mini del" title="Remove this fly">✕</button></span>
      <span style="color:var(--dim)">${s.t ? (s.t / 1000).toFixed(1) + 's' : '…'}</span></div>`; }).join('');
  $('#flies').querySelectorAll('.fly').forEach(el => {
    const id = +el.dataset.id;
    el.onclick = () => { selected = id; renderFlyList(); };
    el.querySelector('.ren').onclick = ev => { ev.stopPropagation();
      const f = flies.find(x => x.id === id); if (!f) return;
      const n = prompt('Name this fly:', f.name); if (n !== null) renameFly(id, n); };
    el.querySelector('.del').onclick = ev => { ev.stopPropagation();
      const f = flies.find(x => x.id === id); if (!f) return;
      if (confirm(`Remove ${f.name}? Its worker is terminated, its saved brain is deleted, and the slot is freed for a new fly.`)) removeFly(id); };
    el.querySelector('.exp')?.addEventListener('click', async ev => { ev.stopPropagation();
      const f = flies.find(x => x.id === id); if (!f) return;
      await saveFlyRecord(f, { force: true });      // write the live brain before exporting it
      if (!await store.exportFly(f.name)) alert(`No saved brain for ${f.name} yet.`); });
  });
  const f = flies.find(x => x.id === selected); $('#selsec').hidden = !f;
  $('#takeoff').textContent = f?.last?.takeoffPending ? (running ? 'Takeoff queued' : 'Takeoff queued · press Run') : 'Activate takeoff DNs';
  $('#takeoff').disabled = !f?.ready || f.last?.flying || f.last?.alive === false;
  if (f?.last) { const s = f.last, c = s.cmd || {};
    $('#sel').innerHTML = `<div class="kv"><span>behaviour</span><span style="color:var(--acc)">${s.behavior || ''}</span><span>energy</span><span>${(s.energy * 100).toFixed(0)}%</span><span>health</span><span>${(s.health * 100).toFixed(0)}%</span>
      <span>food eaten</span><span>${(s.eaten * 1000).toFixed(1)} mg·eq</span><span>distance travelled</span><span>${(s.dist || 0).toFixed(1)} cm</span><span>takeoffs / flights</span><span>${s.jumps || 0} / ${s.flights || 0}</span><span>endogenous state</span><span>${s.drive || '–'}</span>${s.nm ? `<span>AKH / insulin</span><span>${s.nm.akh.toFixed(2)} / ${s.nm.dilp.toFixed(2)}</span><span>octopamine (AKHR neurons)</span><span>${s.nm.oa.toFixed(1)} Hz, arousal ${(s.nm.arousal * 100).toFixed(0)}%</span>` : ''}<span>walk drive (BDN2/oDN1/P9)</span><span>${(c.drive || 0).toFixed(0)} Hz</span>
      <span>backward (MDN)</span><span>${(c.back || 0).toFixed(0)} Hz</span><span>steering (DNa01/02)</span><span>${(c.turn || 0).toFixed(2)}</span>
      <span>giant fibre</span><span>${(c.escape || 0).toFixed(0)} Hz</span><span>MN9 (proboscis)</span><span>${(s.mn9 || 0).toFixed(0)} Hz</span>
      <span>pharyngeal pump</span><span>${((s.feeding || 0) * 100).toFixed(0)}%</span><span>sensory neurons driven</span><span>${s.nSensory}</span></div>`; }
}

// ---------------- brain panel: what the selected fly sees, and its named neuron groups ----------------
const HIST = 150;                    // samples kept per trace (~18 s at the 120 ms poll)
let groups = [], hist = [], histFly = -1, hover = -1, hlShown = -1, hlPts = null, eyeDots = null;
// hovered group's neurons as large points over the inset (small groups vanish among 165k somas otherwise)
function showGroupInInset(j) {
  hlShown = j; hlPts.visible = j >= 0; if (j < 0) return;
  if (groups[j] && groups[j].plottable === 0) { hlPts.visible = false; return; }   // nothing to draw; the row says why
  const g = groups[j], src = brainPts.geometry.attributes.position.array, pos = [];
  for (const ix of [g.L, g.R]) for (const i of ix) if (src[i * 3] < 1e5) pos.push(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
  hlPts.geometry.dispose(); hlPts.geometry = new THREE.BufferGeometry(); hlPts.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  hlPts.material.color.set(g.color);
}
function buildBrainPanel(data) {
  groups = buildGroups(bodymap, meta.types, data.side);
  // How many of a group's neurons can actually be PLOTTED. Peripheral sensory afferents have no
  // soma coordinates at all -- their cell bodies sit in the antenna, proboscis and legs, outside
  // the imaged volume, and only their axon terminals are in the dataset. Measured on this file:
  // olfactory 0/2,639, gustatory 0/1,428, thermosensory 0/25, hygrosensory 0/66, mechanosensory
  // 0/1,733, tactile 0/2,558, unknown sensory 0/1,707, visual 28/4,107 -- against 99-100% for
  // central populations. Without this count the panel highlights nothing and looks broken.
  for (const g of groups) {
    let n = 0;
    for (const ix of [g.L, g.R]) for (const i of ix) if (Number.isFinite(data.soma[i * 3])) n++;
    g.plottable = n;
  }
  $('#groups').innerHTML = groups.map((g, j) => `<div class="g${g.plottable ? '' : ' nosoma'}" data-j="${j}">
      <span class="name"><i style="background:${g.color}"></i>${g.label} <small>${g.L.length + g.R.length}</small>${g.plottable ? '' : `<em class="nosoma" title="These are peripheral neurons: their cell bodies lie in the antenna, proboscis or legs, outside the imaged volume, so the connectome has no soma coordinates for them. They are simulated and driven normally — there is simply nothing to plot.">no soma</em>`}<button class="q" title="what is this?">?</button></span>
      <canvas width="236" height="48"></canvas><span class="v"><b class="l">–</b><b class="r">–</b></span>
      <div class="info" hidden>${g.info}</div></div>`).join('');
  $('#groups').querySelectorAll('.g').forEach(el => {
    const j = +el.dataset.j;
    el.onmouseenter = () => { hover = j; }; el.onmouseleave = () => { hover = -1; };
    el.querySelector('.q').onclick = () => { const i = el.querySelector('.info'); i.hidden = !i.hidden; };
  });
  // eye columns: azimuth/elevation of each column's viewing direction; the front of each eye faces the middle
  const W = EYE_W, H = EYE_H;
  eyeDots = ['L', 'R'].map(sd => flyvisMap.eyes[sd].dirs.map(([x, y, z]) => {
    const az = Math.atan2(y, x) * 180 / Math.PI, el = Math.asin(Math.max(-1, Math.min(1, z))) * 180 / Math.PI;
    return [(sd === 'L' ? 165 - az : 10 - az) / 175 * (W - 8) + 4, (69 - el) / 129 * (H - 8) + 4];
  }));
  $('#brainpanel').hidden = false;
}
// ---- per-fly eye rows -------------------------------------------------------------------
// The activity poll is already round-robin over every fly, so each fly's 721-column luminance
// pair arrives periodically -- it was simply being discarded for all but the selected fly,
// which made the eyes the only panel here that showed one animal while the stack beside it
// showed all of them. Drawing every fly's costs nothing extra in message traffic.
const EYE_W = 150, EYE_H = 104;
function eyeRows() { return $('#eyerows'); }
function eyeAddFly(f) {
  const host = eyeRows(); if (!host || host.querySelector(`[data-id="${f.id}"]`)) return;
  const row = document.createElement('div');
  row.className = 'eyerow'; row.dataset.id = f.id;
  row.innerHTML = `<span class="who"><i style="background:${f.color}"></i><b></b></span>
    <canvas width="${EYE_W}" height="${EYE_H}"></canvas><canvas width="${EYE_W}" height="${EYE_H}"></canvas>`;
  row.onclick = () => { selected = f.id; renderFlyList(); eyeLabels(); };
  host.appendChild(row);
  eyeLabels();
}
function eyeRemoveFly(id) { eyeRows()?.querySelector(`[data-id="${id}"]`)?.remove(); eyeLabels(); }
function eyeLabels() {
  const host = eyeRows(); if (!host) return;
  for (const row of host.children) {
    const f = flies.find(x => x.id === +row.dataset.id); if (!f) continue;
    row.querySelector('b').textContent = f.name;
    row.querySelector('i').style.background = f.color;
    row.classList.toggle('sel', f.id === selected);
  }
  const n = host.children.length;
  const c = $('#eyeCount'); if (c) c.textContent = n ? `${n} fl${n === 1 ? 'y' : 'ies'}` : '';
}
/** Paint one fly's two 721-column luminance maps. `eyes` is null when ?vision=0. */
function drawEyes(f, eyes) {
  const row = eyeRows()?.querySelector(`[data-id="${f.id}"]`); if (!row || !eyeDots) return;
  const cv = row.querySelectorAll('canvas');
  for (let sd = 0; sd < 2; sd++) {
    const cx = cv[sd].getContext('2d');
    cx.fillStyle = '#05070c'; cx.fillRect(0, 0, EYE_W, EYE_H);
    if (!eyes) {
      cx.fillStyle = '#5b6472'; cx.font = '10px system-ui, sans-serif'; cx.textAlign = 'center';
      cx.fillText('vision off', EYE_W / 2, EYE_H / 2); continue;
    }
    const lum = eyes[sd], dots = eyeDots[sd];
    for (let c = 0; c < dots.length; c++) {
      const v = Math.round(255 * Math.min(1, lum[c]));
      cx.fillStyle = `rgb(${v},${v},${v})`;
      cx.beginPath(); cx.arc(dots[c][0], dots[c][1], 2.6, 0, 6.2832); cx.fill();
    }
  }
}

function onActivity(f, m) {
  if (histFly !== f.id) { histFly = f.id; hist = groups.map(() => [[], []]); $('#bpTitle').innerHTML = `Inside fly ${f.id} <i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${f.color}"></i>`; }
  const rows = $('#groups').children;
  groups.forEach((g, j) => {
    const h = hist[j]; h[0].push(m.groups[j * 2]); h[1].push(m.groups[j * 2 + 1]); if (h[0].length > HIST) { h[0].shift(); h[1].shift(); }
    const row = rows[j], cv = row.querySelector('canvas'), cx = cv.getContext('2d'), w = cv.width, hh = cv.height;
    const peak = Math.max(5, ...h[0], ...h[1]);
    cx.clearRect(0, 0, w, hh);
    [[h[0], '#6cb6ff'], [h[1], '#ff9f5a']].forEach(([ys, c]) => { cx.strokeStyle = c; cx.lineWidth = 2; cx.beginPath();
      ys.forEach((y, i) => { const px = w - (ys.length - 1 - i) * w / (HIST - 1), py = hh - 3 - y / peak * (hh - 6); i ? cx.lineTo(px, py) : cx.moveTo(px, py); }); cx.stroke(); });
    const fmt = (x) => x >= 100 ? x.toFixed(0) : x.toFixed(1);
    const v = row.querySelector('.v'); v.children[0].textContent = g.L.length ? fmt(m.groups[j * 2]) + ' Hz' : '–'; v.children[1].textContent = g.R.length ? fmt(m.groups[j * 2 + 1]) + ' Hz' : '–';
  });

}

// ---------------- looming threat: a dark sphere swoops toward the selected fly's head from the front-side ----------------
let threatMesh = null, threatAnim = null;
// targetId defaults to the selected fly (the UI button); callers may name one instead.
// Falls back to any living fly, so a programmatic caller isn't silently a no-op when the
// selected fly is dead or hasn't reported a pose yet.
function launchThreat(targetId = selected) {
  const live = x => x.last && x.last.alive !== false;
  const f = flies.find(x => x.id === targetId && live(x)) || flies.find(live);
  if (!f) return;
  const p = f.last.pos, yaw = f.last.yaw, a = yaw + 0.6;
  const start = [p[0] + 3.0 * Math.cos(a), p[1] + 3.0 * Math.sin(a), 1.6], end = [p[0] + 0.25 * Math.cos(a), p[1] + 0.25 * Math.sin(a), 0.45];
  if (!threatMesh) { threatMesh = new THREE.Mesh(new THREE.SphereGeometry(0.35, 32, 16), new THREE.MeshStandardMaterial({ color: '#0d0d10', roughness: 0.6 })); threatMesh.castShadow = true; scene.add(threatMesh); }
  threatAnim = { t0: performance.now(), start, end, dur: 700 / speed };
}
function updateThreat() {
  if (!threatAnim) return;
  const u = Math.min(1, (performance.now() - threatAnim.t0) / threatAnim.dur), k = u * u;   // accelerating approach
  const pos = threatAnim.start.map((s, i) => s + (threatAnim.end[i] - s) * k);
  if (u >= 1 && performance.now() - threatAnim.t0 > threatAnim.dur + 600) { threatAnim = null; env.threat = null; threatMesh.visible = false; shadowDirty = true; syncEnv(); return; }
  threatMesh.visible = true; threatMesh.position.set(...pos); env.threat = { x: pos[0], y: pos[1], z: pos[2] };
  for (const fl of flies) if (fl.ready) fl.worker.postMessage({ type: 'env', env: { threat: env.threat } });
}

// ---------------- Janus: the ringmaster as a red glowing orb the flies can actually see ----------------
// This is not scenery. world.js gives every fly a non-colliding `janus` mocap sphere in the eyes'
// ray group, fly.js gives it an emissive albedo, and the position below is mirrored into each
// worker at 20 Hz -- flyvis resamples at 50 Hz, so that is faster than the eye can resolve. The
// orb therefore appears in the 721-column luminance image, drives the optic lobe, and is a
// small bright moving object of exactly the kind LC10 responds to.
// maxStay/cooldown keep the orb punctuation rather than furniture: Janus reacts to the flies
// often enough that, ungated, a busy stretch would hold it in the air continuously. It stays
// for at most one visit, then keeps out of the ring for a while whatever Janus is saying.
const ORB = { r: 0.16, hover: 0.85, drift: 0.55, driftS: 0.09, bobS: 0.5, bob: 0.10,
              fadeIn: 450, fadeOut: 1100, maxStay: 11000, cooldown: 16000 };
let orbGroup = null, orbCore = null, orbHalo = [], orbLight = null;
const ORB_DIM = new THREE.Color('#b40d10'), ORB_HOT = new THREE.Color('#ff3a1e');
let orbPresence = 0, orbGlow = 0, orbUntil = 0, orbSpokeAt = -1e9, orbSynced = 0, orbHere = null, orbWasOut = true, orbLastNow = 0;
let orbArrived = 0, orbLeftAt = -1e9;

function buildOrb() {
  orbGroup = new THREE.Group(); orbGroup.visible = false;
  // Unlit and untone-mapped: a lit material with a high emissive drives the bloom straight to
  // white and the orb reads pink. Basic material + an explicit colour ramp keeps it red, and
  // the brightness is carried by the additive shells instead.
  orbCore = new THREE.Mesh(new THREE.SphereGeometry(ORB.r, 32, 24),
    new THREE.MeshBasicMaterial({ color: LOOK.orb, transparent: true, toneMapped: false }));
  orbGroup.add(orbCore);
  // two additive shells make the bloom read as a glow rather than a flat ball
  orbHalo = [1.55, 2.6].map((k, i) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(ORB.r * k, 24, 16),
      new THREE.MeshBasicMaterial({ color: LOOK.orbGlow, transparent: true, opacity: i ? 0.10 : 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide, toneMapped: false }));
    orbGroup.add(m); return m;
  });
  // Units are centimetres and the whole arena is r = 2.5, so a metre-scale lamp washes the
  // entire ring red. Range is kept under half a centimetre-ish of useful falloff and the
  // intensity low: the orb should pool light on what is directly beneath it, not gel the set.
  orbLight = new THREE.PointLight(LOOK.orb, 0.20, 1.1, 2);   // no shadow map: it lights the ring, it does not cast
  orbGroup.add(orbLight);
  scene.add(orbGroup);
}

/** Centroid of the living flies, so Janus materialises among them rather than at a fixed mark. */
function flyCentroid() {
  let n = 0, x = 0, y = 0;
  for (const f of flies) if (f.last && f.last.alive !== false) { x += f.last.pos[0]; y += f.last.pos[1]; n++; }
  return n ? [x / n, y / n] : [0, 0];
}

/**
 * Janus speaks: the orb winks into being above the flies for the length of the line, then fades.
 * It is absent the rest of the time -- parked below the world, out of the eye rays entirely.
 * @param {number} holdMs how long to stay before fading out
 */
function janusSpeak(holdMs = 4200) {
  if (!RINGMASTER) return;
  const now = performance.now();
  const here = orbPresence > 0.02 || !orbWasOut;
  if (!here && now - orbLeftAt < ORB.cooldown) return;   // it just left; let the ring breathe
  if (!here) {                        // arriving: pick a fresh spot among the flies
    const [cx, cy] = flyCentroid(), a = Math.random() * Math.PI * 2, R = 0.9;
    orbHere = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), phase: Math.random() * 100 };
    orbArrived = now;
  }
  orbSpokeAt = now;
  // A later line can extend the visit, but never past maxStay from when it arrived.
  orbUntil = Math.min(orbArrived + ORB.maxStay, Math.max(orbUntil, now + Math.max(1200, holdMs)));
}

/**
 * Take the orb out of the world: hidden, and env.janus cleared so every worker parks its mocap
 * sphere below the floor and the eye rays stop hitting it.
 *
 * This must also happen when the page is hidden. animate() early-returns on document.hidden, so
 * without it the orb would freeze mid-flight and every fly would go on seeing a bright object
 * hanging motionless in the air for as long as the tab stayed in the background -- which would
 * quietly contaminate exactly the long unattended runs this is meant to support.
 */
function retireOrb() {
  if (orbWasOut) return;
  orbWasOut = true; orbPresence = 0; orbGlow = 0; orbUntil = 0; orbLeftAt = performance.now();
  if (orbGroup) orbGroup.visible = false;
  env.janus = null;
  for (const fl of flies) if (fl.ready) fl.worker.postMessage({ type: 'env', env: { janus: null } });
}

// The orb is driven by BOTH the render loop and this timer, and integrates on measured elapsed
// time, so calling it more often only makes it smoother. That matters because requestAnimationFrame
// stops when the page is backgrounded while the fly workers keep simulating: driven by rAF alone,
// a backgrounded orb would freeze in mid-air and every fly would go on seeing a bright stationary
// object indefinitely. The timer keeps retiring and moving it even at the 1 Hz a throttled tab gets.
let orbTicker = null;
function startOrbTicker() { if (RINGMASTER && !orbTicker) orbTicker = setInterval(() => updateOrb(performance.now()), 100); }

function updateOrb(now) {
  if (!RINGMASTER) return;
  if (!orbGroup) buildOrb();
  const present = now < orbUntil;
  // presence drives both the render and what the flies see: arriving and leaving are gradual,
  // so the optic lobe sees a brightening/dimming object rather than one that teleports.
  const dt = Math.min(100, now - (orbLastNow || now)); orbLastNow = now;
  orbPresence = Math.max(0, Math.min(1, orbPresence + dt / (present ? ORB.fadeIn : -ORB.fadeOut)));
  if (orbPresence <= 0 && !present) { retireOrb(); return; }
  orbWasOut = false; orbGroup.visible = true;
  const t = now / 1000, ph = orbHere?.phase || 0;
  // flare for ~1.6 s after each line, over a resting shimmer
  const since = (now - orbSpokeAt) / 1600;
  const flare = since >= 0 && since < 1 ? (1 - since) ** 2 : 0;
  const target = Math.min(1, 0.25 + 0.12 * Math.sin(t * 2.7) + 0.75 * flare) * orbPresence;
  orbGlow += (target - orbGlow) * 0.12;
  // a small slow drift around where it arrived, so it reads as hovering with the flies
  const a = (t + ph) * ORB.driftS * Math.PI * 2;
  const x = (orbHere?.x || 0) + ORB.drift * Math.cos(a), y = (orbHere?.y || 0) + ORB.drift * 0.6 * Math.sin(2 * a);
  const z = ORB.hover + ORB.bob * Math.sin((t + ph) * ORB.bobS * Math.PI * 2);
  orbGroup.position.set(x, y, z);
  const s = (0.25 + 0.75 * orbPresence) * (1 + 0.10 * orbGlow);
  orbCore.scale.setScalar(s); orbCore.material.opacity = orbPresence;
  orbCore.material.color.copy(ORB_DIM).lerp(ORB_HOT, orbGlow);   // deep red at rest, hot red when it speaks
  orbHalo[0].material.opacity = (0.14 + 0.26 * orbGlow) * orbPresence;
  orbHalo[1].material.opacity = (0.05 + 0.15 * orbGlow) * orbPresence;
  orbHalo.forEach(h => h.scale.setScalar((0.35 + 0.65 * orbPresence) * (1 + 0.18 * orbGlow)));
  orbLight.intensity = (0.12 + 0.30 * orbGlow) * orbPresence;
  shadowDirty = true;
  // Hand the orb to the flies at 20 Hz. A per-frame post would be 6 workers x 60 Hz for a
  // position the 50 Hz eye cannot resolve any faster than this.
  if (now - orbSynced < 50) return;
  orbSynced = now;
  env.janus = { x, y, z, glow: orbGlow };
  for (const fl of flies) if (fl.ready) fl.worker.postMessage({ type: 'env', env: { janus: env.janus } });
}

// ---------------- persistent per-fly brains ----------------
// Saved: identity + the learned mushroom-body overlay (114 kB per fly). NOT saved: membrane
// potentials, the shared connectome, or the physics world -- none of those is what makes one
// fly different from another, and all three are rebuilt on load in under a second.
const MB_SIG = () => store.mbSignature(mushroom);
let saveToken = 0, saveTimer = null;

/** Ask a fly's worker for its current mushroom-body weights. Resolves null if it has none. */
function requestMB(f, timeoutMs = 4000) {
  if (!f.ready) return Promise.resolve(null);
  f.mbPending ||= new Map();
  const token = ++saveToken;
  return new Promise(res => {
    const done = m => { clearTimeout(t); res(m); };
    const t = setTimeout(() => { f.mbPending.delete(token); res(null); }, timeoutMs);
    f.mbPending.set(token, done);
    f.worker.postMessage({ type: 'exportmb', token });
  });
}

/** Write one fly to the local store, keyed by its name. */
async function saveFlyRecord(f, { force = false } = {}) {
  if (!PERSIST) return false;
  const m = await requestMB(f);
  if (!m) { if (!force) return false; }
  // Nothing learned yet and nothing forced: no point rewriting 114 kB of zeros.
  if (m && !m.dirty && !force) return false;
  try {
    await store.saveFly({
      name: f.name, color: f.color, sex: f.sex, createdAt: f.createdAt,
      simMs: m?.simMs || 0, energy: m?.energy, health: m?.health, lastPos: m?.pos || null,
      mbSig: MB_SIG(), mb: m?.mb || null,
    });
    f.savedAt = Date.now();
    return true;
  } catch (e) { console.warn(`[flystore] save "${f.name}" failed`, e); return false; }
}

async function saveAllFlies(opts) {
  if (!PERSIST) return;
  for (const f of flies) await saveFlyRecord(f, opts);
}

/**
 * Bring back the flies from last session. Returns true if it restored any, so the caller
 * knows not to spawn the preset's default flies on top of them.
 */
async function restoreFlies() {
  if (!PERSIST) return false;
  let saved;
  try { saved = await store.listFlies(); } catch (e) { console.warn('[flystore] unavailable', e); return false; }
  if (!saved.length) return false;
  const sig = MB_SIG();
  let n = 0, stale = 0;
  for (const meta of saved.slice(0, FLY_CAP)) {
    const rec = await store.loadFly(meta.name, sig);
    if (!rec) continue;
    if (rec.stale) stale++;
    // Put it back roughly where it was, nudged inside the wall.
    const R = env.arena.radius - 0.45;
    let [x, y] = rec.lastPos || [0, 0];
    const d = Math.hypot(x, y); if (!Number.isFinite(d) || d > R) { const a = n * 2.4; x = 1.2 * Math.cos(a); y = 1.2 * Math.sin(a); }
    await addFly([x, y], Math.atan2(-y, -x), rec.sex || 'm', rec);
    n++;
  }
  if (n) status(`restored ${n} fl${n === 1 ? 'y' : 'ies'} from local store${stale ? ` (${stale} with a stale brain, started naive)` : ''}`);
  return n > 0;
}

function startAutosave() {
  if (!PERSIST) return;
  // Every 20 s, and again whenever the page is being closed or hidden. Only dirty brains are
  // written, so an idle fly costs one postMessage and nothing else.
  saveTimer = setInterval(() => saveAllFlies(), 20000);
  addEventListener('pagehide', () => saveAllFlies({ force: true }));
  addEventListener('visibilitychange', () => { if (document.hidden) saveAllFlies(); });
}

// ---------------- Janus restaging the ring: look changes the flies' world, not just ours ----------------
/**
 * Swap the arena's surfaces. rebuildEnv() already regenerates the floor texture, wall, bunting,
 * tent and props from LOOK, so changing LOOK and rebuilding restages everything. The part that
 * matters biologically is the last line: albedo() in every worker is handed the new reflectances,
 * so a dungeon is genuinely darker to the flies' photoreceptors than the big top was.
 */
function setLook(name) {
  const next = LOOKS[name]; if (!next || next === LOOK) return false;
  LOOK = next;
  if (scene) scene.background = new THREE.Color(LOOK.sky);
  applyLighting(LOOK);
  rebuildEnv();
  for (const f of flies) if (f.ready) f.worker.postMessage({ type: 'look', look: LOOK.albedo });
  shadowDirty = true;
  return true;
}

// ---------------- the monster: something that hunts ----------------
// A dark mass that pursues the nearest living fly. It is a real geom in every fly's world, so
// the eye rays hit it and it grows in the visual field as it closes -- and while it is hunting
// it also drives env.threat, which is the existing looming channel into DNp01 and the escape
// reflex. So the flies flee it through the same pathway a real looming predator would use,
// rather than through anything bolted on for the occasion.
const MON = { speed: 0.55, turn: 2.2, z: 0.30, giveUpCm: 0.22, threatCm: 1.1, hunt: 26000 };
let monsterMesh = null, monsterState = null, monsterLast = 0;

function buildMonster() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 18),
    new THREE.MeshStandardMaterial({ color: '#0a0910', roughness: 0.85, metalness: 0.0 }));
  body.scale.set(1.12, 0.86, 0.8); body.castShadow = true; g.add(body);
  for (const sx of [-1, 1]) {                                  // two dim eyes, so it reads as alive
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10),
      new THREE.MeshBasicMaterial({ color: '#ff3a1e', toneMapped: false }));
    e.position.set(0.24, sx * 0.1, 0.08); g.add(e);
  }
  scene.add(g); return g;
}

/** Set a monster loose on the flies for `ms` of wall time. */
function releaseMonster(ms = MON.hunt) {
  const live = flies.filter(f => f.last && f.last.alive !== false);
  if (!live.length) return false;
  if (!monsterMesh) monsterMesh = buildMonster();
  // enter from the wall, away from everyone
  const a = Math.random() * Math.PI * 2, R = env.arena.radius - 0.15;
  monsterState = { x: R * Math.cos(a), y: R * Math.sin(a), yaw: a + Math.PI, until: performance.now() + ms };
  monsterLast = performance.now();
  return true;
}

function recallMonster() {
  if (!monsterState) return;
  monsterState = null;
  if (monsterMesh) monsterMesh.visible = false;
  env.monster = null; if (!threatAnim) env.threat = null;
  for (const f of flies) if (f.ready) f.worker.postMessage({ type: 'env', env: { monster: null, threat: env.threat } });
}

function updateMonster(now) {
  if (!monsterState) return;
  const dt = Math.min(0.1, (now - monsterLast) / 1000); monsterLast = now;
  if (now > monsterState.until) { recallMonster(); window.__ringmaster?.say('The beast tires of you. This time.', { priority: 2 }); return; }
  // chase the nearest living fly
  const live = flies.filter(f => f.last && f.last.alive !== false);
  if (!live.length) { recallMonster(); return; }
  let target = live[0], best = Infinity;
  for (const f of live) { const d = Math.hypot(f.last.pos[0] - monsterState.x, f.last.pos[1] - monsterState.y); if (d < best) { best = d; target = f; } }
  const want = Math.atan2(target.last.pos[1] - monsterState.y, target.last.pos[0] - monsterState.x);
  let dy = want - monsterState.yaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
  monsterState.yaw += Math.max(-MON.turn * dt, Math.min(MON.turn * dt, dy));
  // ease off once it is right on top of a fly, so it stalks rather than jittering through it
  const sp = MON.speed * (best < MON.giveUpCm ? 0.15 : 1);
  monsterState.x += sp * dt * Math.cos(monsterState.yaw);
  monsterState.y += sp * dt * Math.sin(monsterState.yaw);
  const R = env.arena.radius - 0.1, d0 = Math.hypot(monsterState.x, monsterState.y);
  if (d0 > R) { monsterState.x *= R / d0; monsterState.y *= R / d0; }
  const bob = 0.04 * Math.sin(now / 260);
  monsterMesh.visible = true;
  monsterMesh.position.set(monsterState.x, monsterState.y, MON.z + bob);
  monsterMesh.rotation.z = monsterState.yaw;
  shadowDirty = true;
  if (now - (monsterState.synced || 0) < 50) return;
  monsterState.synced = now;
  env.monster = { x: monsterState.x, y: monsterState.y, z: MON.z + bob };
  // close enough to loom: feed the existing threat channel so escape fires through DNp01
  const near = best < MON.threatCm;
  if (!threatAnim) env.threat = near ? { ...env.monster } : null;
  for (const f of flies) if (f.ready) f.worker.postMessage({ type: 'env', env: { monster: env.monster, threat: env.threat } });
}

// ---------------- render loop ----------------
let lastFrame = performance.now(), fpsN = 0, fpsT = 0, lastSim = 0, lastSimReal = performance.now();
const q = new THREE.Quaternion(), previousQ = new THREE.Quaternion(), followDelta = new THREE.Vector3(), brainBase = new THREE.Color();
function updateShadows(now) {
  const extent = Math.min(env.arena.radius + 0.5, Math.max(0.35, camera.position.distanceTo(controls.target) * 0.75));
  const center = controls.target;
  // Quantise camera following to avoid constantly shifting the shadow texels.
  if (Math.abs(extent - shadowExtent) > Math.max(0.04, extent * 0.1) || center.distanceToSquared(shadowCenter) > (extent * 0.06) ** 2) {
    shadowExtent = extent; shadowCenter.copy(center);
    sun.target.position.copy(center); sun.position.copy(center).add(shadowOffset);
    Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent });
    sun.shadow.camera.updateProjectionMatrix(); shadowDirty = true;
  }
  if (shadowDirty && now - lastShadow >= 1000 / 30) {
    renderer.shadowMap.needsUpdate = true; shadowDirty = false; lastShadow = now; metrics.shadowUpdates++;
  }
}
const shadowOffset = new THREE.Vector3(3, 2, 8);
function animate() {
  requestAnimationFrame(animate);
  updateOrb(performance.now());   // before the hidden check: see the orbTicker comment below
  if (document.hidden) return;
  const now = performance.now(); fpsT += now - lastFrame; lastFrame = now; if (++fpsN === 30) { $('#fps').textContent = (30000 / fpsT).toFixed(0); fpsN = 0; fpsT = 0; }
  for (const f of flies) {
    const s = f.last; if (!s || !f.bodyGroups) continue;
    const previous = f.prev, blend = running && previous && s.t>previous.t ? Math.min(1,(now-f.recvAt)/f.poseInterval) : 1;
    f.poseUpdated = f.drawnPose !== s || f.drawnBlend !== blend;
    if (f.poseUpdated) {
      shadowDirty = true;
      for (let b = 1; b < f.bodyGroups.length; b++) { const g = f.bodyGroups[b]; if (!g) continue;
        g.position.set(s.xpos[b * 3], s.xpos[b * 3 + 1], s.xpos[b * 3 + 2]);
        q.set(s.xquat[b * 4 + 1], s.xquat[b * 4 + 2], s.xquat[b * 4 + 3], s.xquat[b * 4]);
        if (blend<1) {
          g.position.x=previous.xpos[b*3]+(g.position.x-previous.xpos[b*3])*blend;
          g.position.y=previous.xpos[b*3+1]+(g.position.y-previous.xpos[b*3+1])*blend;
          g.position.z=previous.xpos[b*3+2]+(g.position.z-previous.xpos[b*3+2])*blend;
          previousQ.set(previous.xquat[b*4+1],previous.xquat[b*4+2],previous.xquat[b*4+3],previous.xquat[b*4]);
          q.slerpQuaternions(previousQ,q,blend);
        }
        g.quaternion.copy(q); g.updateMatrix();
      }
      f.ring.position.set(s.pos[0], s.pos[1], 0.003);
      updateWingBlur(f, s); f.drawnPose = s; f.drawnBlend = blend;
    }
    f.ring.visible = f.id === selected;
  }
  const sf = flies.find(x => x.id === selected);
  if (sf?.last && $('#follow').checked) { const p = sf.last.pos; followDelta.set(p[0], p[1], p[2]).sub(controls.target).multiplyScalar(0.1); controls.target.add(followDelta); camera.position.add(followDelta); }
  if (sf?.last) { const t = sf.last.t / 1000; $('#simt').textContent = t.toFixed(2); if (now - lastSimReal > 1000) { $('#rt').textContent = ((t - lastSim) / ((now - lastSimReal) / 1000)).toFixed(2); lastSim = t; lastSimReal = now; } }
  updateThreat(); updateMonster(now); controls.update();
  camera.updateMatrixWorld();
  viewFrustum.setFromProjectionMatrix(viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  let largest = 0;
  const projection = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  for (const f of flies) {
    if (!f.last) continue;
    flyBounds.center.fromArray(f.last.pos);
    viewPoint.fromArray(f.last.pos).applyMatrix4(camera.matrixWorldInverse);
    const pixels = viewPoint.z < 0 && viewFrustum.intersectsSphere(flyBounds) ? 0.3 * projection / Math.max(0.05, -viewPoint.z) : 0;
    largest = Math.max(largest, pixels);
    const changed = f.setDetail(pixels);
    if (changed) shadowDirty = true;
    batches.update(f, f.poseUpdated, changed);
  }
  batches.finish();
  resolution.update(now, largest > 290);
  if (threatAnim) shadowDirty = true;
  updateShadows(now);
  renderer.info.reset(); const renderStart = performance.now(); composer.render();
  metrics.renderMs = performance.now() - renderStart; metrics.calls = renderer.info.render.calls; metrics.triangles = renderer.info.render.triangles;
  // The trace arrives at ~8 Hz. Upload colours only when the trace, selection or highlight changes.
  // Rotate/draw the inset at 30 Hz independently from the main camera.
  if ($('#brainpanel').classList.contains('folded') || now - lastBrainDraw < 1000 / 30) return;
  const elapsed = Math.min(0.1, (now - lastBrainDraw) / 1000); lastBrainDraw = now;
  if (brainDirty || brainColorFly !== selected || brainColorHover !== hover) {
    const col = brainPts.geometry.attributes.color, a = col.array;
    brainBase.set(sf?.color || '#888'); const dim = hover >= 0 ? 0.08 : 1;
    for (let i = 0; i < brainAct.length; i++) {
      const v = Math.min(1, brainAct[i] * 1.6);
      a[i * 3] = dim * (0.1 + v * (brainBase.r - 0.1)); a[i * 3 + 1] = dim * (0.11 + v * (brainBase.g - 0.11)); a[i * 3 + 2] = dim * (0.14 + v * (brainBase.b - 0.14));
    }
    col.needsUpdate = true; brainDirty = false; brainColorFly = selected; brainColorHover = hover; metrics.brainUploads++;
  }
  if (hover !== hlShown) showGroupInInset(hover);
  brainPts.rotation.y += elapsed * 0.12; hlPts.rotation.copy(brainPts.rotation); brainRenderer.render(brainScene, brainCam); metrics.brainDraws++;
  drawStack();

}
main().catch(e => { if ($('#status')) status('error: ' + e.message); console.error(e); });

// side panels fold to their title bar (chevron button, or the [ and ] keys); the choice persists
function setupFolds() {
  const folds = [['#panel', '#panelFold', '[', '‹', '›', 'controls'], ['#brainpanel', '#bpFold', ']', '›', '‹', 'brain panel']];
  const apply = ([panel, btn, key, open, shut, what], folded) => {
    $(panel).classList.toggle('folded', folded); const b = $(btn);
    b.textContent = folded ? shut : open; b.title = `${folded ? 'Show' : 'Hide'} ${what} (${key})`; b.setAttribute('aria-expanded', String(!folded));
    try { localStorage.setItem(`fold${panel}`, folded ? '1' : ''); } catch {}
  };
  for (const f of folds) {
    let saved = false; try { saved = localStorage.getItem(`fold${f[0]}`) === '1'; } catch {}
    apply(f, saved);
    $(f[1]).onclick = () => apply(f, !$(f[0]).classList.contains('folded'));
  }
  addEventListener('keydown', e => {
    if (e.target.closest?.('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const f = folds.find(x => x[2] === e.key); if (f) apply(f, !$(f[0]).classList.contains('folded'));
  });
}

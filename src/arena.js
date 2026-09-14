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
import { buildMushroomIndex } from './sim/mushroom.js';
const BASE = import.meta.env.BASE_URL; // "/" in dev, "/fly-brain/" on GitHub Pages

const $ = s => document.querySelector(s);
const status = s => { $('#status').textContent = s; };
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
// Arena look. 'circus' is a big-top: black/white checker floor, red/yellow tent stripes,
// bunting, saturated props. 'lab' is the original muted tan/grey. ?theme=lab to switch back.
// This is NOT purely cosmetic: the floor and wall albedos in FlyAgent.albedo() are kept in
// step with these, so a higher-contrast arena drives the photoreceptors harder.
const THEME = new URLSearchParams(location.search).get('theme') === 'lab' ? 'lab' : 'circus';
const LOOK = {
  circus: { floorA: '#12121a', floorB: '#f0ede4', wallA: '#e02128', wallB: '#f6c624',
            prop: ['#21c8e4', '#ff4fa3', '#9ae62c', '#ff8a2b', '#a45cff', '#2bd9b0'],
            bunting: ['#21c8e4', '#ff4fa3', '#f6c624', '#9ae62c'], food: '#ffd84d', sky: '#1a0f1e',
            tent: true, stair: { x: -1.3, y: -1.3, color: '#e02128', pole: '#8e1118' },
            // relative luminance of the four surfaces above, handed to the flies' albedo()
            albedo: { floorLo: 0.06, floorHi: 0.92, wallLo: 0.29, wallHi: 0.77 } },
  lab:    { floorA: '#6f6554', floorB: '#9c907a', wallA: '#2a2a2e', wallB: '#c9c9cf',
            prop: ['#3d4a3d'], bunting: null, food: '#f2c14e', sky: '#0b0e14',
            tent: false, stair: null,
            albedo: { floorLo: 0.35, floorHi: 0.60, wallLo: 0.15, wallHi: 0.75 } },
}[THEME];
// Ringmaster: narrates the flies and restages the arena between "adventures". On by default
// with the circus theme, off for 'lab'. ?ringmaster=0 / =1 forces it either way.
// ⚠️ It mutates env on a timer, so DISABLE IT FOR BENCHMARKS (?ringmaster=0) -- a run that
// changes the food, wind and light halfway through is not measuring one thing.
const RM_FLAG = new URLSearchParams(location.search).get('ringmaster');
const RINGMASTER = RM_FLAG === '1' || (RM_FLAG !== '0' && THEME === 'circus');
const env = PRESET.env();
// The staircase is a real obstacle, not scenery. Pushing its treads into env.obstacles means
// world.js builds collision geoms, clearance() senses them, and the eye rays hit them -- all
// from one definition, because env is what gets sent to every worker.
if (LOOK.stair) env.obstacles.push(...spiralStaircase(LOOK.stair));
/** 16 raised, rotated treads around a newel post: 30 degrees and 0.062 cm per step (~1.33 turns, ~1 cm tall). */
function spiralStaircase({ x, y, color, pole }) {
  const N = 16, rise = 0.062, turn = Math.PI / 6, rHelix = 0.34, out = [];
  for (let k = 0; k < N; k++) {
    const th = k * turn;
    out.push({ type: 'box', x: x + rHelix * Math.cos(th), y: y + rHelix * Math.sin(th), z: k * rise,
      sx: 0.22, sy: 0.055, sz: 0.03, yaw: th, color });   // sx runs radially outward from the post
  }
  out.push({ type: 'cylinder', x, y, r: 0.06, sz: (N - 1) * rise + 0.08, color: pole });
  return out;
}
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
  if (PRESET.flySpots) for (const s of PRESET.flySpots.slice(0, FLY_CAP)) await addFly(s.pos, s.yaw, s.sex);
  else { await addFly([st0[0], st0[1]], st0[2]);
    for (let k = 1; k < Math.min(PRESET.flies || 1, FLY_CAP); k++) { const ang = k * 2.4; await addFly([1.2 * Math.cos(ang), 1.2 * Math.sin(ang)], ang + Math.PI); } }
  if (PRESET.autoThreat) setInterval(() => { if (!running || !flies.length) return; const live = flies.filter(f => f.last?.alive !== false); if (!live.length) return; selected = live[Math.floor(Math.random() * live.length)].id; launchThreat(); }, PRESET.autoThreat * 1000);
  window.__arena = { camera, controls, flies, env, THREE, renderer, scene, gtao, composer, metrics, resolution, batches, visual, addFly, rebuildEnv, launchThreat, FLY_CAP, MAX_FLIES };
  animate();
  if (RINGMASTER) window.__ringmaster = startRingmaster(window.__arena);
}

// ---------------- scene ----------------
let renderer, scene, camera, controls, envGroup, raycaster, floorMesh, sun, composer, gtao, resolution;
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
  scene.add(new THREE.HemisphereLight('#f4f2ed', '#514432', 0.22));
  sun = new THREE.DirectionalLight('#fff1da', 2.7); sun.position.set(3, 2, 8); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.00002; sun.shadow.normalBias = 0.0003; sun.shadow.radius = 2;
  Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.1, far: 20 }); scene.add(sun, sun.target);
  const rim = new THREE.DirectionalLight('#f9e5c4', 0.65); rim.position.set(-3, -2, 3); scene.add(rim);
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
function rebuildEnv() {
  // Placement rebuilds own their resources; release old GPU buffers/textures before replacing them.
  envGroup.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose(); } });
  envGroup.clear(); shadowDirty = true;
  const R = env.arena.radius;
  // floor: same 0.4 cm checker the flies' eyes see
  const cv = document.createElement('canvas'); cv.width = cv.height = 64; const cx = cv.getContext('2d');
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { cx.fillStyle = ((i + j) & 1) ? LOOK.floorB : LOOK.floorA; cx.fillRect(i * 32, j * 32, 32, 32); }
  const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set((R + 0.2) * 2 / 0.8, (R + 0.2) * 2 / 0.8); tex.magFilter = THREE.LinearFilter; tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); tex.colorSpace = THREE.SRGBColorSpace;
  floorMesh = new THREE.Mesh(new THREE.CircleGeometry(R + 0.1, 96), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  floorMesh.receiveShadow = true; envGroup.add(floorMesh);
  // striped wall (24 stripes), matching the visual environment used for the compound eye
  const wc = document.createElement('canvas'); wc.width = 1024; wc.height = 8; const wx = wc.getContext('2d');
  for (let k = 0; k < 24; k++) { wx.fillStyle = (k & 1) ? LOOK.wallB : LOOK.wallA; wx.fillRect(k * 1024 / 24, 0, 1024 / 24 + 1, 8); }
  const wt = new THREE.CanvasTexture(wc); wt.colorSpace = THREE.SRGBColorSpace;
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.05, R + 0.05, env.arena.wallHeight, 96, 1, true), new THREE.MeshStandardMaterial({ map: wt, side: THREE.BackSide, roughness: 0.9 }));
  wall.rotation.x = Math.PI / 2; wall.position.z = env.arena.wallHeight / 2; envGroup.add(wall);
  if (LOOK.bunting) addBunting(R, env.arena.wallHeight);
  if (LOOK.tent) addTentCeiling(R, env.arena.wallHeight);
  for (const [i, o] of env.obstacles.entries()) { const m = new THREE.Mesh(o.type === 'box' ? new THREE.BoxGeometry(o.sx * 2, o.sy * 2, o.sz) : new THREE.CylinderGeometry(o.r, o.r, o.sz, 32), new THREE.MeshStandardMaterial({ color: o.color || LOOK.prop[i % LOOK.prop.length], roughness: 0.45, metalness: 0.05 }));
    if (o.type !== 'box') m.rotation.x = Math.PI / 2; else if (o.yaw) m.rotation.z = o.yaw;
    m.position.set(o.x, o.y, (o.z || 0) + o.sz / 2); m.castShadow = m.receiveShadow = true; envGroup.add(m); }
  for (const f of env.food) { const m = discMesh(f.r, LOOK.food, 0.35 + 0.65 * Math.min(1, f.amount / 5)); m.position.set(f.x, f.y, 0.002); m.userData.food = f; envGroup.add(m); }
  for (const b of env.bitterPatches) { const m = discMesh(b.r, '#4f8fd6', 0.9); m.position.set(b.x, b.y, 0.002); envGroup.add(m); }
  for (const h of env.hazards) { const m = discMesh(h.r, '#d9502f', 0.9); m.position.set(h.x, h.y, 0.002); envGroup.add(m); const glow = discMesh(h.r + 0.4, '#d9502f', 0.12, 0.001); glow.position.set(h.x, h.y, 0.001); envGroup.add(glow); }
  for (const o of env.odors) { // plume as a soft radial gradient
    const g = document.createElement('canvas'); g.width = g.height = 128; const gx = g.getContext('2d'); const grd = gx.createRadialGradient(64, 64, 0, 64, 64, 64);
    const col = o.odor === 'co2' ? '120,200,255' : '190,255,120'; grd.addColorStop(0, `rgba(${col},0.45)`); grd.addColorStop(1, `rgba(${col},0)`); gx.fillStyle = grd; gx.fillRect(0, 0, 128, 128);
    const m = new THREE.Mesh(new THREE.CircleGeometry(o.sigma * 2.2, 48), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(g), transparent: true, depthWrite: false }));
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

async function addFly(pos, yaw, sex = 'm') {
  if (flies.length >= FLY_CAP) { alert(`Fly limit reached: ${FLY_CAP}. Delete one first.`); return; }
  const id = takeSlot(), color = FLY_COLORS[id % FLY_COLORS.length];
  const worker = new Worker(new URL('./sim/fly.worker.js', import.meta.url), { type: 'module' });
  const f = { id, slot: id, name: `Fly ${id}`, worker, color, sex, ready: false, last: null, prev: null, stats: {}, ...buildFlyMesh(color, sex) };
  scene.add(f.group); flies.push(f); batches.add(f); stackAddFly(id);
  worker.onmessage = e => onWorker(f, e.data);
  worker.postMessage({ type: 'init', id, graph: shared, meta, bodymap, flyXML, gait, env, pos, yaw, nProxies: MAX_FLIES - 1, mode: $('#mode').value, brainOpts: brainParams, neuromod: neuromodCalib, vision: !NO_VISION, sex, look: LOOK.albedo,
    brainMem: { memory: brainMem.memory, graph: brainMem.graph, bases: brainMem.bases, opts: brainMem.opts, fv: brainMem.fv }, wasmModule, slot: id, flyvisMap, mushroom, learn: LEARN });
  await new Promise(res => { f.onReady = res; });
  if (running) worker.postMessage({ type: 'run' });
  worker.postMessage({ type: 'speed', speed });
  renderFlyList();
  return f;
}

/** Remove a fly for good: kill its worker, free its GPU/CPU resources and recycle its slot. */
function removeFly(id) {
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
  stackRemoveFly(f.slot);
  if (selected === id) selected = flies[0]?.id ?? -1;
  shadowDirty = true; batches.dirty = true;
  broadcastOthers(true);                      // stop the survivors sensing a ghost proxy
  renderFlyList(); stackLabels(true);
  window.__ringmaster?.say(`${f.name} has left the circus. Do not ask where.`, { priority: 2 });
  return true;
}

function renameFly(id, name) {
  const f = flies.find(x => x.id === id);
  if (!f) return false;
  f.name = String(name).trim().slice(0, 24) || `Fly ${id}`;
  renderFlyList(); stackLabels(true);
  if (id === selected) $('#bpTitle').innerHTML = `Inside ${f.name} <i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${f.color}"></i>`;
  return true;
}
function onWorker(f, m) {
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
    if (f.id === selected && (f.activityTime !== m.t || histFly !== f.id)) {   // the selected fly also drives the big inset
      f.activityTime = m.t; brainAct.set(m.trace); brainDirty = true; onActivity(f, m);
    }
  }
}
let foodDirty = false, lastOthers = 0;
function broadcastOthers(force = false) {
  const now = performance.now(); if (!force && now - lastOthers < 1000 / 30) return; lastOthers = now;
  const poses = flies.filter(o => o.last && o.last.alive !== false).map(o => ({ id:o.id, x:o.last.pos[0], y:o.last.pos[1], z:o.last.pos[2], yaw:o.last.yaw, sex:o.sex }));
  for (const f of flies) if (f.ready) f.worker.postMessage({ type:'others', others:poses.filter(o => o.id !== f.id) });
}
function syncEnv() { for (const f of flies) if (f.ready) f.worker.postMessage({ type: 'env', env }); }

// ---------------- UI ----------------
function buildUI() {
  $('#play').onclick = () => { running = !running; for (const f of flies) f.worker.postMessage({ type: running ? 'run' : 'pause' }); $('#play').textContent = running ? '❚❚ Pause' : '▶ Run'; };
  $('#addFly').onclick = () => { const a = Math.random() * Math.PI * 2, r = Math.random() * env.arena.radius * 0.6; addFly([r * Math.cos(a), r * Math.sin(a)], Math.random() * Math.PI * 2); };
  $('#addFemale').onclick = () => { const a = Math.random() * Math.PI * 2, r = Math.random() * env.arena.radius * 0.6; addFly([r * Math.cos(a), r * Math.sin(a)], Math.random() * Math.PI * 2, 'f'); };
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
      <span class="flyact"><button class="mini ren" title="Rename">✎</button><button class="mini del" title="Remove this fly">✕</button></span>
      <span style="color:var(--dim)">${s.t ? (s.t / 1000).toFixed(1) + 's' : '…'}</span></div>`; }).join('');
  $('#flies').querySelectorAll('.fly').forEach(el => {
    const id = +el.dataset.id;
    el.onclick = () => { selected = id; renderFlyList(); };
    el.querySelector('.ren').onclick = ev => { ev.stopPropagation();
      const f = flies.find(x => x.id === id); if (!f) return;
      const n = prompt('Name this fly:', f.name); if (n !== null) renameFly(id, n); };
    el.querySelector('.del').onclick = ev => { ev.stopPropagation();
      const f = flies.find(x => x.id === id); if (!f) return;
      if (confirm(`Remove ${f.name}? Its worker is terminated and the slot is freed for a new fly.`)) removeFly(id); };
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
  const g = groups[j], src = brainPts.geometry.attributes.position.array, pos = [];
  for (const ix of [g.L, g.R]) for (const i of ix) if (src[i * 3] < 1e5) pos.push(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
  hlPts.geometry.dispose(); hlPts.geometry = new THREE.BufferGeometry(); hlPts.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  hlPts.material.color.set(g.color);
}
function buildBrainPanel(data) {
  groups = buildGroups(bodymap, meta.types, data.side);
  $('#groups').innerHTML = groups.map((g, j) => `<div class="g" data-j="${j}">
      <span class="name"><i style="background:${g.color}"></i>${g.label} <small>${g.L.length + g.R.length}</small><button class="q" title="what is this?">?</button></span>
      <canvas width="236" height="48"></canvas><span class="v"><b class="l">–</b><b class="r">–</b></span>
      <div class="info" hidden>${g.info}</div></div>`).join('');
  $('#groups').querySelectorAll('.g').forEach(el => {
    const j = +el.dataset.j;
    el.onmouseenter = () => { hover = j; }; el.onmouseleave = () => { hover = -1; };
    el.querySelector('.q').onclick = () => { const i = el.querySelector('.info'); i.hidden = !i.hidden; };
  });
  // eye columns: azimuth/elevation of each column's viewing direction; the front of each eye faces the middle
  const W = 168, H = 116;
  eyeDots = ['L', 'R'].map(sd => flyvisMap.eyes[sd].dirs.map(([x, y, z]) => {
    const az = Math.atan2(y, x) * 180 / Math.PI, el = Math.asin(Math.max(-1, Math.min(1, z))) * 180 / Math.PI;
    return [(sd === 'L' ? 165 - az : 10 - az) / 175 * (W - 8) + 4, (69 - el) / 129 * (H - 8) + 4];
  }));
  $('#brainpanel').hidden = false;
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
  if (m.eyes) ['#eyeL', '#eyeR'].forEach((id, s) => {
    const cx = $(id).getContext('2d'), lum = m.eyes[s], dots = eyeDots[s];
    cx.fillStyle = '#05070c'; cx.fillRect(0, 0, 168, 116);
    for (let c = 0; c < dots.length; c++) { const v = Math.round(255 * Math.min(1, lum[c])); cx.fillStyle = `rgb(${v},${v},${v})`; cx.beginPath(); cx.arc(dots[c][0], dots[c][1], 3, 0, 6.2832); cx.fill(); }
  });
  else ['#eyeL', '#eyeR'].forEach(id => {   // ?vision=0: no eyes sampled, say so rather than leave a stale frame
    const cx = $(id).getContext('2d');
    cx.fillStyle = '#05070c'; cx.fillRect(0, 0, 168, 116);
    cx.fillStyle = '#5b6472'; cx.font = '11px system-ui, sans-serif'; cx.textAlign = 'center';
    cx.fillText('vision off', 84, 62);
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
  updateThreat(); controls.update();
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

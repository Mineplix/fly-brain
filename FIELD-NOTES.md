# fly-brain — field notes

Working notes on how this project actually behaves, written while getting it running
locally. The repo's own docs are thin; this is the "what's really going on" companion.

**Conventions:** ✅ = verified by running it on this machine. 📖 = read from source but not
yet executed. ❓ = inference, not confirmed.

Target machine for all measurements:
- Intel i7-14650HX, **16 physical / 24 logical cores**
- **15.7 GB RAM** (not 18 — check `Get-CimInstance Win32_ComputerSystem` if this matters)
- RTX 4050 laptop GPU (6 GB) + Intel UHD `gen-12lp` integrated GPU
- Windows 11, Node 24.19.0 LTS, npm 11.17.0

---

## 1. Setup — what actually blocks you

✅ **The packed data files ARE committed.** This contradicts the natural reading of the
README, which describes them as outputs of the prep pipeline. You do **not** need to run
anything in `scripts/`, and you do not need to download anything from the live demo.

Present in `public/data/`, all tracked in git:

| file | size | deployed? |
|---|---|---|
| `graph.flyg` | 14.6 MB | yes |
| `skeletons.flys` | 11.6 MB | yes |
| `meta.json` | 3.2 MB | yes |
| `neurons.flyn` | 1.0 MB | yes |
| `graph_w3.bin` | 63.7 MB | **no** — stripped at build |
| `neurons.bin` | 5.4 MB | **no** — stripped at build |

The two `NOT_DEPLOYED` files exist for the Node scripts and the Python pipeline. A
`vite.config.js` plugin (`dropUnpacked`) deletes them from `dist/` after build. So the
repo is ~100 MB on disk but the deployed payload is ~30 MB.

✅ **`vite.config.js` reads the data files at config-load time**, not at request time:

```js
const DATA_FILES = Object.fromEntries([...].map(f => {
  const b = fs.readFileSync(`public/data/${f}`);   // throws here if missing
  ...
```

Consequence worth remembering: if those files ever go missing, **Vite dies before the dev
server starts**, and the error looks like a config crash, not a missing-asset error. Don't
go hunting in the loader.

It hashes each file and injects `__DATA_FILES__` (sha1 prefix + byte length) so the decode
worker gets versioned URLs and exact progress even when the host gzips responses.

### Node

No `.nvmrc` / `.node-version` / `engines` field. Vite 8 requires `^20.19 || >=22.12`.
Node 24 LTS works. ✅

**Windows gotcha:** after installing Node mid-session, `npm install` will succeed but
`npm run dev` fails with `'"node"' is not recognized`. npm itself resolves, but the shell
it spawns for the script doesn't have the new PATH. Restart the shell, or prepend
`$env:ProgramFiles\nodejs` to `$env:Path`.

### Cross-origin isolation

✅ Verified, not assumed. `vite.config.js` sets both on `server` and `preview`:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Confirmed live: response headers present on `/arena.html`, and in-page
`self.crossOriginIsolated === true`. There's also a `public/coi-serviceworker.js` as a
fallback for static hosts that can't set headers (e.g. GitHub Pages).

---

## 2. ⚠️ The big performance finding: the GPU backend is the slow path

This is the single most important thing in these notes.

✅ **`attachBrain()` defaults to WebGPU and only falls back to WASM on an exception:**

```js
// src/brainsetup.js:40
if (mem.opts.gpu !== false && typeof navigator !== 'undefined' && navigator.gpu) {
  try { ... return applyClassPhysiology(gb, ...); }      // WebGPU
  catch (e) { console.warn('WebGPU brain unavailable, falling back to WASM:', e); }
}
// ... LIFWasm
```

There is **no benchmark and no adapter check**. If `navigator.gpu` merely *exists*, the
WebGPU kernel is used, however slow that GPU is.

✅ **Measured, one fly, same machine, same scene, 20 s sample each:**

| brain backend | sim-seconds per wall-second | relative |
|---|---|---|
| WebGPU (default) | **0.0013×** | 1× |
| WASM (`?gpu=0`) | **0.043×** | **~32× faster** |

The WebGPU path is ~32× *slower* than WASM on an Intel `gen-12lp` iGPU. The mechanism is
in the worker loop — every step awaits GPU completion:

```js
// src/sim/fly.worker.js
if (steps && fly.brain.device) await fly.brain.device.queue.onSubmittedWorkDone();
```

Per-dispatch latency on a weak iGPU dominates completely; the kernel's arithmetic is
irrelevant next to the round-trip.

### ❗ Suspected root cause — a one-line fix worth trying

`src/lifgpu.js:158` requests an adapter with **no power preference**:

```js
const adapter = await navigator.gpu.requestAdapter();
```

On a laptop with switchable graphics, Chrome's default adapter is the **integrated** GPU.
So even on a machine with an RTX 4050, this likely selects the Intel iGPU — the slow path
— unless the user has forced a GPU preference at the OS or browser level.

Adding `{ powerPreference: 'high-performance' }` is a plausible one-line improvement.
**Not yet tested on the 4050** ❓ — see the caveat below.

### ⚠️ Caveat on all GPU numbers above

Measured inside a browser pane that **cannot see the RTX 4050 at all**. Verified:
`requestAdapter({powerPreference:'high-performance'})` returns Intel `gen-12lp`, and
WebGL reports `ANGLE (Intel, Intel(R) UHD Graphics ...)`. The discrete GPU is not exposed
to that context.

So: the **WASM number (0.043×) is representative** of this hardware — it's CPU-only and
the CPU is the same either way. The **WebGPU number is not** a verdict on the 4050. It is
a verdict on what happens when WebGPU silently lands on an iGPU, which is exactly what
`requestAdapter()` with no preference invites. Re-measure both in real Chrome.

### `?gpu=0`

```
http://localhost:5173/arena.html?gpu=0
```

Forces the WASM kernel (`src/arena.js:46`). Undocumented in the README. On any machine
where WebGPU picks a weak adapter, this is the fast path.

**Debugging note:** the `brain backend: WebGPU` / fallback message is `console.info`, and
console history survives navigation in some tooling — a stale line can make you think the
flag didn't take. Check `location.search` directly rather than trusting the log.

---

## 3. The `scripts/` claim about GPU usage needs revising

A natural assumption from the README is that this design "barely uses the GPU — it's CPU +
WASM". That's **wrong as stated**: WebGPU is the *default* brain backend, and
`src/lifgpu.js` is a substantial 328-line compute-shader implementation. A batched-GPU
rewrite would not be starting from zero.

---

## 4. The event-driven claim checks out ✅

Worth stating clearly because it's easy to suspect the opposite. **`lif_step` does NOT do
dense work over the ~10.5 M connections.**

`src/wasm/lif.c`, step 1 — synapse delivery is driven off the fired-spike ring buffer, and
only touches the outgoing edges of neurons that actually spiked:

```c
for (int32_t k = 0; k < na; k++) {          // na = number that fired
  int32_t pre = arr[k]; ...
  uint32_t a = indptr[pre], e = indptr[pre + 1];
  if (s > 0) for (uint32_t j = a; j < e; j++) gE[indices[j]] += W[j] * s;
```

Steps 3 and 4 (membrane update, threshold check) **are** dense — but over the 165,122
*neurons*, not the connections. That's a deliberate, vectorisable choice, and the comment
says so (`// 3. membrane update for every neuron (vectorisable)`). ~330 k cheap float ops
per step is not the pathology.

`src/lif.js` (the pure-JS reference kernel) goes further and is fully event-driven, with
an explicit `awake`/`awakeList` set and neurons that "sleep" when they return to rest. The
two kernels therefore differ in *how much* they skip, though they implement the same model.
`LIFWasm.nAwake` returns `this.N` — a deliberate admission that the WASM path doesn't
track an awake set, not a bug.

The flyvis kernel `fv_step` skips non-firing sources (`if (r <= 0.f) continue;`).

---

## 5. Worker / concurrency model (Phase 2)

### 5.1 How a fly is spawned

`addFly(pos, yaw, sex)` — `src/arena.js:195` — is the **only** spawn path. Everything
(presets, the UI buttons, the console) goes through it.

```js
async function addFly(pos, yaw, sex = 'm') {
  if (nextId >= MAX_FLIES) { alert(`At most ${MAX_FLIES} flies`); return; }
  const id = nextId++;
  const worker = new Worker(new URL('./sim/fly.worker.js', import.meta.url), { type: 'module' });
  ...
  worker.postMessage({ type: 'init', id, graph: shared, ..., slot: id, ... });
  await new Promise(res => { f.onReady = res; });     // blocks until the worker says 'ready'
  if (running) worker.postMessage({ type: 'run' });
```

✅ **One dedicated ES-module Web Worker per fly — confirmed**, not just claimed. The worker
header says *"One embodied fly per worker: its own connectome brain + MuJoCo physics
world."* Each worker calls `loadMujoco()` and builds its own `FlyAgent`, so **every fly has
a private MuJoCo model + data**. Physics is not shared between flies.

Note `addFly` is `await`ed — flies are spawned **strictly serially**, each waiting for the
previous worker's `ready`. Spawning N flies costs N sequential worker boots.

### 5.2 Where the fly count is set — three places

1. **Per preset** (`src/sim/world.js`) — each preset declares its own count:
   `foraging: 1`, `openfield: 3`, `predator: 2`, `maze: 1`, `social: 5`,
   `courtship` uses `flySpots` (2: one male, one female). Selected by `?env=<key>`.
2. **The initial spawn loop** (`src/arena.js:58-60`) — reads `PRESET.flies`, arranges
   extras on a circle of radius 1.2 at 2.4 rad spacing.
3. **Interactive** — the `+ Fly` / `+ ♀` buttons (`arena.js:233-234`) call `addFly` at a
   random position.

So there is **no single global "number of flies" constant** to edit. `MAX_FLIES` is a cap,
not a count.

### 5.3 ⚠️ `MAX_FLIES = 12` is a *lifetime* budget, not a concurrency limit

This matters for Phase 3 and is easy to miss.

✅ Verified by grep: there is **no `worker.terminate()`, no `flies.splice()`, no removal or
recycle path anywhere in `arena.js`**. `nextId` only ever increments
(`let nextId = 0;` … `const id = nextId++;`).

Consequences:
- A fly that dies (`alive: false`) keeps its worker alive forever. Its `FlyAgent.step()`
  early-returns (`if (!this.alive) return;`), so it burns almost no CPU, but the slot is
  gone.
- Once 12 flies have *ever* been spawned, `addFly` alerts and refuses. **The only way back
  is a page reload.**
- Therefore a ramp test can only go **up**. Each "reduce the fly count" measurement needs a
  fresh page load. Plan benchmarks as monotonic ramps.

`MAX_FLIES` is also baked into `allocBrainMemory(..., maxFlies)`, which sizes the single
shared `WebAssembly.Memory` up front. Raising the cap means re-sizing that allocation, not
just changing a guard.

### 5.4 What is shared vs. per-fly

| | shared once | per fly |
|---|---|---|
| connectome graph (indptr/indices/weights/sign) | ✅ one copy in `SharedArrayBuffer` | — |
| LIF state (v, gE, gI, refr, trace, adapt, res, spikeCount, ring…) | — | ✅ one block per slot |
| flyvis weights (45,669 nodes / 1,513,231 edges) | ✅ `sharedParts` | — |
| flyvis state (v, acc, x) | — | ✅ **two** blocks (one per eye) |
| MuJoCo model + data | — | ✅ entirely private |

This is what cross-origin isolation buys. Adding a fly costs **state + a MuJoCo world**,
never another copy of the 10.5 M-edge graph. The brief's "VRAM/RAM is not the constraint"
holds.

### 5.5 Timesteps — four clocks, and how they nest

The outer unit is **`FlyAgent.step()` = exactly 1 ms of simulated time**.

| clock | rate | where |
|---|---|---|
| **MuJoCo physics** | 0.2 ms → **5 substeps per tick** | `world.js` rewrites `timestep="0.0001"` → `"0.0002"`; `fly.js:21` `physPerMs = round(0.001 / timestep)` |
| **LIF brain** | 0.5 ms → **2 steps per tick** | `lif.js` `DEFAULTS.dt`; `fly.js:154` literally `this.brain.step(); this.brain.step();` |
| **Sensory + motor exchange** | **every tick = 1 kHz** | `fly.js:113` `senses.update(st, env, 1)`, `:157` `motor.readBrain(spikeCount, 1)`, `:165` `motor.apply(this.t, 1, …)` |
| **Vision (flyvis)** | **every 20 ms = 50 Hz** | `fly.js:115` `if (this.fv && (this.t % 20 === 0))` |
| *vision (fallback `CompoundEye`)* | *every 10 ms = 100 Hz* | `fly.js:114` `this.t % 10 === 0` |
| body-contact / bristle scan | every 10 ms | `fly.js:72` `if (this.t % 10 === 0)` |
| pose → render thread | 30 Hz | `POSE_EVERY = 1000/30`, worker |
| `others` broadcast (fly ↔ fly) | 30 Hz | `broadcastOthers()`, `arena.js:224` |
| activity panel poll | ~8 Hz (120 ms) | `setInterval(..., 120)`, `arena.js:241` |

So one tick is: read physics state → senses (+ vision on the 20 ms boundary) → set sensory
drive → **2 × LIF** → motor readout → **5 × MuJoCo** → physiology.

📌 **The header comment in `fly.js` is stale.** It says *"physics (10 x 0.1 ms MuJoCo
steps)"*, but `world.js` rewrites the timestep to 0.2 ms, making it **5 × 0.2 ms**. The
comment describes flybody's original value, not what runs. Don't trust it.

**Everything is locked to the 1 ms tick.** There is no independent "sensory/motor exchange
rate" knob — senses and motor run every tick by construction. The only rate that is
genuinely decoupled is vision (the `t % 20` test). That makes vision the one cheap thing to
change, which is exactly why Phase 4 is the big lever.

### The pacing loop — a real ceiling

```js
while (running && simAhead >= 1 && steps < 8 && performance.now() - t0 < 8) { fly.step(); ... }
...
if (running) timer = setTimeout(loop, 0);
```

Three caps interact:
1. **≤ 8 sim-ms per loop iteration** (`steps < 8`)
2. **≤ 8 ms of wall time per iteration** (yields early if a step is slow)
3. **`setTimeout(loop, 0)` is clamped by the browser to ~4–5 ms** ✅ (measured 4.9 ms in a
   *visible, focused* tab)

So the structural ceiling is roughly 8 sim-ms per ~5 ms wall ≈ **1.6× real time**, and
that's before any actual computation. If a single `fly.step()` exceeds 8 ms, cap (2)
reduces you to one step per iteration and throughput collapses to ~1 sim-ms per 5 ms
= 0.2×.

⚠️ **Benchmarking trap:** `setTimeout` is clamped to **≥1000 ms in hidden/background
tabs**. Any measurement taken with the tab backgrounded is garbage. Always check
`document.visibilityState` before trusting a number. (I chased this as a hypothesis and it
turned out *not* to be the cause here — tab was visible, 4.9 ms — but it will bite.)

`simAhead` is capped at 50 ms of backlog (`if (simAhead > 50) simAhead = 50`), so the sim
does not try to "catch up" indefinitely when it falls behind. It just runs slower. This
means **wall-clock-per-simulated-second is the honest metric**; frame rate is not.

### 5.6 Where the optic-lobe / flyvis path enters

Measured model size (read from `public/vision/`):

| | value |
|---|---|
| flyvis nodes (N) | **45,669** |
| flyvis edges (E) | **1,513,231** |
| cell types | 65 |
| ray directions per eye | **721** (→ `this.n = 1442` rays per fly) |
| flyvis-node → CNS-neuron pairs | L 30,946 + R 31,211 = **62,157** |

That 62,157 figure independently confirms the "~62,000 of 165,122 neurons are optic lobe"
estimate — it's the number of male-CNS neurons that flyvis externally drives.

**The chain, end to end:**

1. **`arena.js` `main()`** fetches `vision/flyvis.bin`, `.json`, `_inputs.json`, `_map.json`
   and builds `const vision = { model: parseFlyVis(fvb, fvj, fvi), map: fvm }`.
2. **`allocBrainMemory(..., vision)`** (`brainsetup.js`) does two things:
   - marks every flyvis-driven neuron as **sensory** —
     `for (const [i] of vision.map.eyes[sd].pairs) sensoryMask[i] = 1`.
     `writeGraph` then **zeroes the incoming chemical synapses of those neurons**, because
     their activity now comes from the flyvis model instead. This is why the toggle is a
     behavioural change, not just a speed-up.
   - lays out shared flyvis weights once + 2 eye-state blocks per fly slot.
3. **`fly.worker.js` init**: `attachEyes(brain.instance, m.brainMem, m.slot)` →
   `flyvis = { eyes, map: m.flyvisMap, gain: 150 }`.
4. **`FlyAgent` constructor** (`fly.js:45-46`) picks the path:
   ```js
   this.fv  = vision && flyvis  ? new FlyVisionFV(...) : null;
   this.eye = vision && !this.fv ? new CompoundEye(...) : null;
   ```
5. **`FlyAgent.step()` line 115**, every 20 ms:
   `if (this.fv && (this.t % 20 === 0)) this.fv.update(...)`.
6. **`FlyVisionFV.update()`** (`sim/vision.js`):
   - `sample()` → one `mj.mj_multiRay(model, data, o, vec, ..., 1442, 50)` call
   - per-ray luminance via `albedo(geomId, x, y, z)` → `lumEye[0]`, `lumEye[1]`
   - `eyes[s].setInput(lumEye[s]); eyes[s].step()` → the `fv_step` WASM kernel
   - node activations above rest → `set([neuron], Hz)` with `gain = 150`, capped at 200 Hz
   - **separately**, photoreceptors are driven by their nearest column's luminance with
     log light-adaptation (`adapt[]`, ~300 ms tau), capped at 250 Hz

`settle()` runs 50 steps at construction under a uniform grey field, stores the result as
`vRest`, and thereafter neurons respond to **deviations from rest**, not absolute activity.

### 🎯 Phase 4 hook — mostly already present

`vision` is **already a boolean threaded all the way through**:
`arena.js` → `postMessage({..., vision: true, ...})` → `fly.worker.js` → `FlyAgent({vision})`
→ `this.fv` / `this.eye`.

`arena.js:202` currently **hardcodes `vision: true`**. Setting it false makes both `fv` and
`eye` null, which skips `mj_multiRay` *and* `fv_step` at the `fly.js:115` guard — exactly
the Phase 4 requirement. The optic-lobe neurons still exist in the graph and simply go
unstimulated.

⚠️ But note step 2 above: `sensoryMask` zeroes those neurons' incoming synapses **at
`allocBrainMemory` time on the main thread**, before any worker exists, and it is applied
whenever `vision` (the model) is passed — independently of the per-fly flag. So a per-fly
`vision:false` leaves those 62,157 neurons **both unstimulated and cut off from their
chemical inputs** — genuinely silent, not merely dark. Whether that's the desired semantics
is a design question for Phase 4, not a bug.

### 5.7 Fly ↔ fly interaction is cheap and indirect

Flies do **not** share a physics world. Each worker's MuJoCo contains `MAX_FLIES - 1 = 11`
kinematic **mocap ellipsoid proxies** (`proxy0..proxy10`, body + head geoms). The main
thread broadcasts every fly's pose at 30 Hz (`broadcastOthers`) and each worker writes them
into its own `mocap_pos` / `mocap_quat` (`setProxies`).

So collisions, occlusion and visual detection of other flies all happen **per-worker
against stand-ins**. Consequences: it scales linearly rather than quadratically in physics
cost, but two flies can interpenetrate slightly since neither's solver is authoritative,
and proxies are parked at `(50+k, 50, -5)` when unused.

---

## 6. Undocumented things found in passing

- **`?gpu=0`** — force WASM brain (above).
- **`?env=<preset>`** — `src/arena.js:21`. Presets in `src/sim/world.js`:
  `foraging` (1 fly), `openfield` (3), `predator` (2), `maze` (1), `social` (5),
  `courtship` (2, one male + one female). **Each preset declares its own fly count** —
  this is where "how many flies" is set today, per-world rather than globally.
- **`fly.html`** — a third entry point alongside `index.html` and `arena.html`, listed in
  the Vite `rollupOptions.input`. Not mentioned in the brief.
- **`public/vision/`** — flyvis model assets.
- **`@mujoco/mujoco` ships an `mt/` directory** — a multithreaded MuJoCo build. Unused so
  far as I can tell ❓, but relevant if physics ever becomes the bottleneck.
- The arena floor is **already a checkerboard** (`rgba=".55 .5 .42 1"` plane plus a
  checker texture in the Three.js scene).

---

## 7. Phase 1 result ✅

One fly spawns, is driven by the connectome, and **walks**.

Observed after ~2 simulated seconds (WASM backend):

- behaviour state machine: `standing` → `proboscis extended` → `walking` → `turning right`
- **distance travelled: 3.6 cm**
- energy decaying 60% → 59% (metabolism live)
- neuron groups firing with sensible structure: Walk-forward 15.1/16.2 Hz,
  Photoreceptors 39.4/37.9 Hz, Grooming 6.8/1.5 Hz, Courtship 3.2/3.1 Hz,
  Octopamine/hunger 3.0 Hz
- both compound-eye views rendering the arena
- no console errors (only a benign `THREE.WebGLProgram` float-precision warning)

**Throughput: 0.043× real time for one fly** on the WASM path — i.e. ~23 s of wall clock
per simulated second. Measure again in real Chrome before treating this as final.

---

## 8. Phase 3 — the worker-pool cap and the measured ceiling

### 8.1 The cap

Added `FLY_CAP` in `src/arena.js`. Default **4**, override with `?flies=N`, hard-clamped to
`MAX_FLIES`. Four small edits, no new dependencies:

- `FLY_CAP` const next to the preset parsing
- `addFly` guard now tests `FLY_CAP` (was `MAX_FLIES`) with a message naming the override
- the preset spawn loop clamps with `Math.min(PRESET.flies || 1, FLY_CAP)`
- `FLY_CAP` / `MAX_FLIES` exposed on `window.__arena` for benchmarking

✅ Verified: the `social` preset declares 5 flies and correctly clamped to 4.

### 8.2 ⚠️ Benchmarking on a contaminated machine — read this first

The first attempt produced nonsense: 2 flies showed **8× less** aggregate throughput than 8
flies, which is physically impossible. Cause was background load:

```
RobloxPlayerBeta  2611 MB      RAM free: 2045 MB of 16092 MB (87% used)
Discord            659 MB      Pagefile in use: 3158 MB
Steam, Vortex, 59 chrome procs  Baseline CPU load: ~50%
```

The machine was **swapping**. On 16 GB, with each fly worker carrying a private MuJoCo
world, adding flies pushed further into the pagefile — so the ramp got worse with N for
reasons unrelated to CPU.

After closing those apps: RAM free **6281 MB**, CPU idle **4%**, 13 chrome procs. Numbers
below are from the quiet machine. **Always check free RAM and baseline CPU before
benchmarking this project.**

### 8.3 The ramp — measured, hot, WASM backend, rendering off

Conditions: `?gpu=0&flies=12&env=foraging`, thermally soaked at 12 flies beforehand,
sampled after a settle delay at each count. Ratio = simulated seconds per wall second.

| flies | per-fly ratio | aggregate | wall-sec per sim-sec (per fly) |
|---:|---:|---:|---:|
| 1 | 0.0148 | 0.0148 | 68 |
| 2 | 0.0116 | 0.0232 | 86 |
| 3 | 0.0111 | 0.0334 | 90 |
| 4 | 0.0110 | 0.0439 | 91 |
| 5 | 0.0107 | 0.0537 | 93 |
| **6** | **0.0100** | **0.0597** | **100** |
| 7 | 0.0088 | 0.0618 | 114 |
| 8 | 0.0076 | 0.0605 | 132 |
| 9 | 0.0079 | 0.0715 | 127 |
| 10 | 0.0073 | 0.0727 | 137 |
| 11 | 0.0046 | 0.0503 | 217 |
| 12 | 0.0057 | 0.0687 | 175 |

Independent re-test at 12 flies on a fresh page load: 0.0062 / 0.0065 / 0.0057 per fly,
aggregate 0.069–0.078. Consistent with the ramp. ✅

**Reading of the curve:**
- **1 → 6 flies: clean parallel scaling.** Per-fly holds ~0.011 (after the 1→2 drop),
  aggregate rises almost linearly.
- **7 → 10: diminishing.** Aggregate creeps 0.060 → 0.073 (+22%) for +67% flies.
- **11 → 12: no gain, high variance.** Aggregate oscillates and per-fly collapses.

**Practical answer: the knee is at ~6 flies.** Past that you are buying slower flies, not
more total simulation.

### 8.4 ❗ The ceiling is not core count

16 physical / 24 logical cores, yet saturation at ~6 workers. The "one fly per physical
core" model in the original brief does not hold. ❓ Most likely memory bandwidth, not
cores: per simulated millisecond each fly does two dense passes over 165,122 neurons
(`lif_step` steps 3–4), and every 20 ms two flyvis eyes each sweep 45,669 nodes /
1,513,231 edges. Cores share bandwidth; adding workers past ~6 adds contention, not
throughput. Not proven — would need a hardware counter profile to confirm.

### 8.5 Thermal behaviour

At a constant 12-fly load, aggregate decayed **0.44 → 0.42 → 0.38 → 0.31**, settling into a
0.31–0.38 band. Roughly **20% lost to throttling, and the plateau arrives in about 3–4
minutes** — much sooner than the 10–15 minutes assumed. Benchmarks taken in the first
minute overstate sustained performance by ~20%.

WMI `CurrentClockSpeed` is useless here (pinned at the 2200 MHz base). CPU *load* rising
while throughput falls is the usable throttle signature.

### 8.6 ⚠️ Unreproduced outlier — recorded, not hidden

One early 12-fly soak measured **0.0365 per fly / 0.44 aggregate** — about **6× higher**
than everything since. Six consecutive samples in that run agreed with each other. I could
not reproduce it: a fresh load with the identical configuration (all 12 spawned while
paused, then Run) gave the normal ~0.006 / ~0.075.

Spawn order was tested and is **not** the explanation. Cause unknown. The reproducible
figure across two independent page loads is ~0.006 per fly at 12 flies, so that is what
the table reports — but the outlier is real data and something about that run was
genuinely different. Worth re-testing before trusting any absolute number too hard.

### 8.7 ⚠️ Rendering was OFF for every measurement

`animate()` begins `if (document.hidden) return;`, and the automation browser pane reports
`document.hidden === true` regardless of tab fronting. Every number above therefore
**excludes the render thread**, and `#fps` reads 0 throughout.

- For the **headless / overnight recording** goal, this is the right condition.
- For **live playback**, these are optimistic. The cost of rendering N flies at 120 Hz with
  shadows, GTAO and per-fly wing blur is **unmeasured** and must be checked in a real
  browser window.

### 8.8 What this means for the overnight goal

At the ~6-fly knee, each fly runs at ~0.010× real time (100 s wall per simulated second).
An 8-hour unattended run yields roughly **4–5 minutes of fly time per fly**, six flies in
parallel. Vision is on in all of this; Phase 4 should improve it materially.

---

## 9. Open questions for later phases

- Does `powerPreference: 'high-performance'` in `lifgpu.js:158` change the picture on the
  4050? If WebGPU on discrete silicon beats 0.043×, the whole Phase 3 calculus changes.
- Is the `steps < 8` / 8 ms cap tunable without breaking the motor loop's freshness
  assumption? The comment warns that an unbounded queue "leaves the motor reading
  increasingly old brain state".
- `MAX_FLIES = 12` is baked into the memory allocation. Raising the worker-pool cap above
  12 means touching `allocBrainMemory`, not just the pool.
- Where does per-fly cost actually go — brain, MuJoCo, or the 1442 raycasts? Needs a
  profile before Phase 4's vision toggle can be predicted rather than guessed.

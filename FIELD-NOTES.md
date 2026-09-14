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

## 2. The two brain backends — and which is actually faster

> ### ❗ CORRECTION — read this before the rest of the section
>
> An earlier version of these notes called WebGPU "the slow path" and treated **0.043× on
> WASM** as this machine's real capability. **That was measured on the wrong GPU.**
>
> Every browser-automation measurement in this file was taken in a preview pane that
> **cannot see the RTX 4050 at all** — `requestAdapter({powerPreference:'high-performance'})`
> returns Intel `gen-12lp` there, always. In the user's **real Chrome**, `chrome://gpu`
> reports `NVIDIA GeForce RTX 4050` and **both** the default and high-performance WebGPU
> adapters return `nvidia`.
>
> Measured in real Chrome on the RTX 4050, one fly:
>
> | backend | sim-sec per wall-sec | |
> |---|---:|---|
> | WASM (`?gpu=0`) | 0.0148 | baseline, rendering off |
> | **WebGPU on the RTX 4050** | **0.0650** | **≥4.4× faster, rendering on at 165 fps** |
>
> ⚠️ An interim version of this note claimed **0.19×** and "13× faster" from a verbally
> reported reading. That number **could not be reproduced** and is withdrawn. The measured
> figure is 0.0650×. The 4.4× is conservative: the WASM baseline had rendering disabled
> while the WebGPU run was also driving the scene at 165 fps.
>
> So the defaults in `attachBrain()` are **right**, not broken. Two conclusions that
> followed from the bad numbers are withdrawn:
>
> - ❌ *"WebGPU is ~32× slower than WASM."* True only when WebGPU lands on a weak iGPU.
> - ❌ *"`lifgpu.js:158` needs `powerPreference: 'high-performance'`."* **No bug.** The
>   plain `requestAdapter()` already returns the discrete GPU on this machine. Tested
>   before writing the patch, which is the only reason a pointless PR wasn't opened.
>
> ⚠️ **Section 8 (the Phase 3 fly-count ceiling) is therefore WASM-only** and understates
> what this machine can do. It needs re-running on WebGPU in real Chrome.
>
> 📌 Method lesson: check *which physical device* a benchmark is running on before drawing
> conclusions from it. The adapter string is one line of JavaScript and would have caught
> this at the start.
>
> ### ❗ The trap that cost the most time: Chrome was on the iGPU too
>
> Even in real Chrome, **`requestAdapter()` and `requestAdapter({powerPreference:'high-performance'})`
> both returned `intel gen-12lp`**, and `WebGL renderer` read `Intel(R) UHD Graphics`. The
> RTX 4050 was installed and idle.
>
> ⚠️ **`chrome://gpu` does not answer this.** It lists every adapter *present*, so it
> cheerfully shows "NVIDIA GeForce RTX 4050" on a machine where Chrome is using the Intel.
> The line that matters is **`GL_RENDERER`**, or simply the WebGPU adapter string.
>
> The fix is **outside the browser and outside this repo** — a Windows per-app graphics
> preference:
>
> ```
> Settings > System > Display > Graphics > Google Chrome > Options > High performance
> ```
> or equivalently the registry value
> `HKCU\SOFTWARE\Microsoft\DirectX\UserGpuPreferences` →
> `"<path>\chrome.exe" = "GpuPreference=2;"`, then a **full** Chrome restart (kill every
> `chrome.exe`; closing the windows is not enough).
>
> After that, both adapters report `nvidia lovelace` and the renderer reports
> `RTX 4050 Laptop GPU`.
>
> **Consequence for `lifgpu.js`: there is no bug.** Once Chrome is on the right device the
> default and high-performance adapters agree, so the `powerPreference` patch — which I
> suspected twice — would change nothing. Anyone benchmarking this project on a laptop
> should check the adapter string first; every number is meaningless until it reads right.

The rest of this section still holds **for the iGPU case**, which is what a machine without
a usable discrete GPU will hit.

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

⚠️ **Superseded — see the correction in section 2.** These figures are WASM-on-iGPU.

WASM path, at the ~6-fly knee: ~0.010× real time, i.e. an 8-hour run gives **4–5 minutes of
fly time per fly**.

### 8.9 ✅ The WebGPU ramp on the RTX 4050

Real Chrome, Chrome forced onto the discrete GPU, rendering **on**, machine already hot,
`?flies=12&bench=1`. Both WebGPU adapters and the WebGL renderer confirmed `nvidia
lovelace` / `RTX 4050 Laptop GPU` before the run.

| flies | per fly | aggregate | fps |
|---:|---:|---:|---:|
| 1 | 0.0650 | 0.0650 | 165 |
| 2 | 0.0570 | 0.1139 | 165 |
| **3** | **0.0470** | **0.1409** | 165 |
| 4 | 0.0287 | 0.1146 | 165 |
| 5 | 0.0260 | 0.1300 | 165 |
| **6** | **0.0247** | **0.1485** | **165** |
| 7 | 0.0209 | 0.1460 | 131 |
| 8 | 0.0181 | 0.1445 | 123 |
| 9 | 0.0165 | 0.1486 | 107 |
| 10 | 0.0156 | 0.1556 | 106 |
| 11 | 0.0146 | 0.1609 | 90 |
| 12 | 0.0102 | 0.1219 | 53 |

**Aggregate throughput saturates at ~3 flies and never exceeds ~0.16.** From 3 onwards
per-fly falls almost exactly as 1/N — the signature of a single shared resource that is
already fully busy. The total amount of fly-time you can produce per wall-second is
**fixed at ~0.15 regardless of fly count**; more flies only subdivides it.

❗ **This is the opposite shape to the WASM path**, which scaled cleanly to ~6 flies before
flattening at ~0.06 aggregate. WebGPU is ~2.5× better in absolute aggregate but saturates
*sooner*, because every fly is dispatching to the **same GPU**, and `fly.worker.js` makes
each one `await device.queue.onSubmittedWorkDone()` every step — so the flies serialise on
one device instead of running in parallel as they do across CPU cores.

📌 **This is exactly the case for the batched GPU rewrite** described in the original brief
— one read of the connectome and a single SpMM per timestep serving all flies, instead of
N independent SpMVs each awaiting completion. The measurement says the per-fly GPU design
cannot go past ~0.16 aggregate no matter how many flies you add, and that batching is the
only thing that would move it. (Still not attempted; it is a large piece of work.)

**Rendering is not the limit below 7 flies** — a flat 165 fps through 6, then decaying to
53 by 12. So the saturation from 3→6 is GPU-compute contention, not draw cost.

### 8.10 Choosing a fly count

Because aggregate is fixed, an 8-hour unattended run produces roughly the same **total**
fly-time whatever you pick — about 70 minutes. What changes is how it is divided:

| flies | each fly gets | total fly-time | live fps |
|---:|---:|---:|---:|
| 3 | ~23 min | ~68 min | 165 |
| 6 | ~12 min | ~71 min | 165 |
| 11 | ~7 min | ~77 min | 90 |

- **Longest continuous behaviour per fly → 3 flies.**
- **Best balance, still perfectly smooth → 6 flies.** Highest count that holds 165 fps, and
  aggregate is within 6% of the maximum. This is the recommended default.
- More than 11 is counterproductive: at 12 both per-fly and aggregate drop.

`?vision=0` on WebGPU is **unmeasured**. It was worth 3.6× on the WASM path; if it helps
similarly here it would raise the aggregate ceiling, which is the number that matters.

---

## 9. Phase 4 — the vision toggle (`?vision=0`)

### 9.1 What it does

`?vision=0` makes every fly blind. Two changes in `src/arena.js`, one commit
(`Add ?vision=0 to run the flies blind`):

1. **`vision: !NO_VISION`** in the worker `init` message (was hardcoded `true`). In
   `FlyAgent` this leaves **both** `this.fv` and `this.eye` null. Passing `vision:false`
   rather than just omitting flyvis matters — with `vision:true` and no flyvis,
   `fly.js:46` would fall back to `new CompoundEye(...)`, which still raycasts.
2. **`const vision = NO_VISION ? null : {...}`** before `allocBrainMemory`.

Point 2 is the subtle one, and it is what makes this match the brief's "unstimulated
rather than deleted". Normally `allocBrainMemory` marks the 62,157 flyvis-driven neurons
as sensory, and `writeGraph` then **zeroes their incoming chemical synapses** because
flyvis replaces that input. Passing `null` skips that, so a blind fly keeps an **intact,
fully wired optic lobe that simply never receives light**. Had we left the mask on, those
neurons would have been inert — functionally deleted.

Default is off. Vision stays on unless the flag is passed.

Also: the eye panels now paint "vision off" instead of leaving a stale last frame.

### 9.2 Speed-up — ✅ measured, one fly

| | sim-sec per wall-sec | wall-sec per sim-sec |
|---|---:|---:|
| vision on | 0.0148 | 68 |
| **vision off** | **0.0527** | **19** |

**3.6× faster** — better than the ~2× the brief predicted. Plausible in hindsight: the flag
removes *three* costs at once, not just the neurons — `mj_multiRay` over 1,442 rays, two
`fv_step` sweeps over 45,669 nodes / 1,513,231 edges at 50 Hz, and the per-step drive of
62,157 neurons.

⚠️ **Single-fly only.** The 6-fly comparison was not obtained — see 9.4.

### 9.3 What visibly changes in behaviour

Group firing rates, one fly, matched sim time (2652 ms sighted vs 3109 ms blind):

| group (L/R Hz) | vision on | vision off |
|---|---|---|
| **Photoreceptors** | 40.40 / 36.02 | **0 / 0** |
| **Looming detectors** | 1.48 / 2.17 | **0 / 0** |
| Smell | 7.97 / 6.25 | 7.86 / 5.86 |
| Walk forward | 14.07 / 14.86 | 7.80 / 10.47 |
| Grooming | 7.46 / 1.61 | 3.10 / 0.35 |
| Courtship circuit | 4.34 / 3.05 | 6.57 / 3.28 |
| Octopamine (hunger) | 5.08 / 0 | 3.39 / 0 |
| Feeding motor | 2.46 / 0.05 | 2.32 / 0.18 |

- **The optic lobe goes exactly silent** — photoreceptors and looming detectors both to
  0/0. That is the flag working as specified.
- **Smell is unchanged** (~8.0/6.0 either way). Good control: the non-visual senses are
  untouched, so the difference really is vision.
- **Walk-forward drive drops roughly a third.** Observed behaviour labels: the sighted fly
  was `walking` (5.4 cm travelled); the blind one was `walking backward` (3.5 cm).
- Grooming lower, courtship slightly higher blind.

⚠️ **n = 1 run per condition, one sample each.** Photoreceptors/looming going to zero is
structural and certain. Everything else in that table is *suggestive only* — single-fly,
single-sample, and the flies start from different random states. Do not treat the
walk-forward or grooming differences as established without repeats.

📌 **Measurement trap found the hard way:** an early sighted sample at sim-t 356 ms showed
Courtship at **86/90 Hz**, which looked like a dramatic collapse when vision was removed.
It was a **startup transient** — at matched sim time it is 4.3/3.1 Hz, i.e. no collapse at
all. Always compare at matched *simulated* time, not matched wall time. With vision on the
fly needs ~3 minutes of wall clock to reach 3 simulated seconds.

### 9.4 ⚠️ What was NOT measured, and why

The 6-fly vision-on/vision-off comparison — the number that would actually size the
multi-fly win — **was not obtained.**

Spawning 6 sighted flies drove free RAM from 6.3 GB to 2.7 GB (Memory Compression 616 MB,
pagefile 1.45 GB) and the page's main thread stopped responding: trivial synchronous script
calls timed out, then navigation itself timed out. CPU was only ~24–46%, so this was
**memory pressure, not compute**.

That is itself a finding worth keeping: on a 16 GB machine, **sighted flies are
memory-expensive enough that ~6 of them can wedge the tab**, independently of whether the
CPU could keep up. It also means the Phase 3 ceiling of ~6 flies may be partly a memory
ceiling rather than purely a bandwidth one.

Outstanding: re-run the 6-fly comparison on a fresh browser with headroom, and check
whether `?vision=0` raises the Phase 3 knee above 6.

---

## 10. The circus arena (`?theme=`)

Restyle toward the Amazing Digital Circus big-top look. `circus` is now the **default**;
`?theme=lab` restores the original muted arena.

### 10.1 Where the arena actually lives

Everything visible is built procedurally in `rebuildEnv()` (`src/arena.js`) from canvas
textures — there is no arena asset to edit:

| element | how it is made |
|---|---|
| floor | 2×2 checker on a 64 px canvas, `RepeatWrapping`, 0.4 cm tiles |
| wall | 24 stripes on a 1024×8 canvas, mapped to an open-ended cylinder, `BackSide` |
| obstacles | `BoxGeometry` / `CylinderGeometry` with a flat colour |
| food / bitter / hazard | flat `CircleGeometry` discs |
| odour plumes | radial-gradient canvas, additive-ish transparent disc |

(`public/body/blender/arena.*` exists and is loaded by `loadArenaDetail`, but the arena
*shell* above is all procedural, so restyling needs no Blender round-trip.)

### 10.2 What changed

- **Floor** `#12121a` / `#f0ede4` — near-black and off-white checker
- **Wall** `#e02128` / `#f6c624` — red/yellow tent stripes, still 24 of them so the
  existing albedo sector maths (`Math.PI / 12`) stays valid
- **Bunting** — new `addBunting()`: a ring of 32 triangular pennants in four colours, plus
  a dark cord. Built as **one alpha-cut texture on a short cylinder band**, not 32 meshes,
  so it is a single draw call and stays out of the shadow and AO passes
- **Props** — obstacles cycle through six saturated colours instead of one dark green
- **Sky** `#1a0f1e`, **food discs** `#ffd84d`

### 10.3 ❗ It is not only cosmetic — the flies see it

`FlyAgent.albedo()` is what the 1,442 eye rays sample every 20 ms, and it **hardcoded the
old arena's reflectances**. A restyle that touched only Three.js would have left the flies
seeing a tan arena that no longer existed.

`albedo()` now takes a `look` object threaded host → worker → `FlyAgent`, defaulting to the
old values. Consequence, in Michelson contrast:

| surface | lab | circus | |
|---|---:|---:|---|
| floor | 0.263 | **0.878** | **3.3× stronger** |
| wall | 0.667 | **0.453** | ~⅓ weaker |

So circus flies get a **much stronger optic-flow signal from the floor** and a **weaker one
from the wall**. Expect that in course control (floor optic flow is a major input to
walking speed and straightness) and in wall-following. ❓ Predicted, not yet measured.

Amusing corollary: the black/white checker is close to the high-contrast gratings used in
real *Drosophila* optomotor experiments, so the circus arena is arguably a *better* visual
stimulus than the muted one it replaces.

### 10.4 Tent canopy

`addTentCeiling()` — an open `ConeGeometry` sitting on the wall top, `BackSide`, striped
with the **same 24-wedge texture as the wall** so the panels line up with the stripes below.

Two deliberate decisions:

- **Purely visual, no collision geom.** `FLIGHT.alt` cruises flies at **0.35–0.75 cm**
  against a **1.2 cm** wall, so nothing can ever reach a canopy above that. Adding physics
  would have been dead weight and would have changed flight behaviour for no benefit.
- **`castShadow = false`.** The sun is at `(3, 2, 8)`, i.e. overhead. A shadow-casting
  canopy would have blacked out the entire arena it is supposed to be lighting.

`BackSide` also means it is invisible from outside, so the camera can still look down into
the arena from above — the cone doesn't block the useful viewing angle.

### 10.5 Spiral staircase — and the obstacle-schema change it forced

16 treads at 30° and 0.062 cm per step (**1.25 turns, 1.01 cm tall**) around a newel post;
17 geoms. Validated numerically: max radius **2.395 cm** inside a 2.5 cm arena, height
**1.01 cm** below the 1.2 cm wall.

**It is a real obstacle, not scenery.** The treads are pushed into `env.obstacles`, and
because `env` is what gets sent to every worker, that single definition gives you collision
geoms (`world.js`), obstacle sensing (`clearance()`), and eye-ray hits — for free.

That required the obstacle schema to grow two optional fields. It previously assumed every
obstacle was a **floor-standing, axis-aligned box**:

| field | meaning | touched |
|---|---|---|
| `o.z` | height of the underside (default 0) | `world.js`, `senses.js`, `arena.js` |
| `o.yaw` | rotation about vertical, boxes only | `world.js`, `senses.js`, `arena.js` |

Two fixes in `clearance()` that matter:

1. It now **rotates the query point into the box's own frame** rather than doing an
   axis-aligned `Math.abs(x - o.x) - o.sx` test, which would have been wrong for every
   tread.
2. A raised tread blocks **only over its own height band** (`z > zb + o.sz` or `z < zb`
   skips it). Without this a spiral staircase would read as a solid column and a fly would
   sense a wall where it can actually walk underneath.

📌 **`flight.js overObstacle()` deliberately left alone.** It ignores both `yaw` and `z`,
but it only answers "is something under me, don't land here". Ignoring `z` is right (the
staircase *is* a solid column from above) and the AABB of a rotated box is conservative,
which errs safe.

⚠️ **This is a behavioural change.** Under `?theme=circus` every preset gains 17 obstacles
near `(-1.3, -1.3)`, including `openfield`, `social` and `courtship`, which were previously
obstacle-free. Use `?theme=lab` for a clean arena when running behavioural comparisons.
The staircase also slightly overlaps the default bitter patch at `(-1.0, -0.7)` — cosmetic
only, since patches are non-colliding flat discs.

### 10.6 ✅ Visually verified

Seen rendering, at 1 fly and at 6. Confirmed on screen:

- black/white checker floor, reading cleanly at arena scale
- red/yellow striped tent wall
- **tent canopy** closing overhead as a striped cone, panels lining up with the wall stripes
- **bunting** — the coloured pennant ring under the wall top
- **spiral staircase** standing on the floor as a red helix
- saturated props, translucent food / bitter / hazard discs
- `?vision=0` working end to end: both eye panels read "vision off" and the Photoreceptors
  group sits at 0.0 / 0.0 Hz while Smell runs at 10.8 / 8.1 Hz

### 10.7 ❗ How the wedged browser was actually recovered

Four `navigate` calls timed out at 300 s each, across two sessions, and freeing memory did
**not** fix it (still timed out with 2.2 GB free). It was never a memory problem — the
**CDP connection to that specific tab** was dead.

**The fix: open a new tab and drive that instead.**

```
tabs_create  ->  tab-1
navigate(url, tabId: "tab-1")   # works immediately
```

The wedged tab disappeared once the new one took over. Worth remembering: if a preview tab
stops responding, a fresh tab costs seconds, whereas retrying navigation on the dead one
costs 5 minutes per attempt.

📌 Screenshots can also fail with *"the page did not finish rendering in time"* when the
desktop app window is minimised or hidden — `animate()` early-returns on `document.hidden`,
so nothing draws and the capture waits forever. Numeric state is still readable via
`javascript_tool` in that condition; only the image capture is blocked.

---

## 11. The six-panel neural stack

One small brain per fly, stacked in the side panel, all live at once — instead of only the
selected fly's.

### 11.1 The constraint that shaped it: message traffic, not pixels

Each `activity` reply carries **`fly.brain.trace.slice(0)` — the full 165,122-neuron trace,
about 660 kB**. The original poll asks one fly every 120 ms (~5.3 MB/s).

Naively polling *every* fly at that rate multiplies it by the fly count: **~32 MB/s at six
flies**, on a machine that had already been driven into swap twice.

**Fix: round-robin the poll.** Total traffic stays exactly one message per 120 ms tick.
The selected fly takes every other slot (so the big inset stays responsive) and the others
share the remainder — at six flies each stack row refreshes ~1.6 Hz. For an activity
monitor that reads fine, and it costs nothing extra.

```js
const f = (sel && (pollTurn & 1)) ? sel : ready[(pollTurn >> 1) % ready.length];
```

### 11.2 Rendering — one canvas, N viewports

- **One `WebGLRenderer`** over a single canvas, `autoClear = false`, `setScissorTest(true)`,
  drawn as N scissored viewports. Clear once, then render each row.
- **Positions are shared** by every row — one buffer for all flies.
- **Each fly owns a colour `BufferAttribute`**, swapped in with `setAttribute('color', …)`
  before its row draws. Three keeps a GPU buffer per attribute object, so a fly's colours
  upload only when its trace arrives, not every frame.
- **Somas subsampled at stride 2.** A row is 84 px tall; 165k points into that is wasted
  bandwidth. ~82k points per row, ~1 MB colour buffer per fly.
- Viewport origin is bottom-left in three, so row *i* sits at `y = h - (i+1)*ROW` to make
  the rows read top-down.

📌 `setViewport`/`setScissor` take **CSS pixels** — three applies the pixel ratio itself.
Multiplying by `devicePixelRatio` manually gives wrong rows on a HiDPI screen.

📌 `stackLabels()` is called from `renderFlyList()`, which also ticks every 500 ms. It
early-returns unless the fly count or selection changed, otherwise it would wipe the live
Hz readouts twice a second.

### 11.3 Placement — a deliberate compromise

The reference video shows a separate floating "Neural activity" window. This is instead
**inside the existing brain panel**, at the top of `#bpBody`.

Reason: that panel is already a right-hand column with working scroll and fold behaviour,
and a second absolutely-positioned panel is exactly the kind of change that needs to be
*looked at* — which was not possible. Moving it out later is a CSS change, not a rewrite.

### 11.4 ✅ Verification status

✅ `npm run build` succeeds (1.4 s, all entry points, no errors).
✅ Source data in `public/data/` confirmed intact afterwards (`dropUnpacked` only touches
`dist/`).
✅ **Seen rendering with 6 flies.** Six labelled rows (`#0`–`#5`), each with its fly's
colour dot and its own green brain, header reading "6 flies".
✅ **Round-robin polling confirmed feeding each row independently** — the per-row rates
read `17.4, 3.4, 10.2, 8.9, 10.5, 10.4 Hz`, i.e. six distinct values, so every fly's trace
is reaching its own panel rather than one fly's being mirrored six times.
✅ Canvas sized correctly: 319 × 504 px for 6 rows at `STACK_ROW = 84`.

### 11.5 ✅ Contrast: resting neurons darkened

The first version read as solid green silhouettes — shape clear, internal structure not.
Cause: the resting colour was itself green, and with normal (non-additive) blending ~82k
overlapping resting points fill the whole outline, leaving spikes nowhere to stand out.

Fixed by making rest near-black and passing the ramp through a smoothstep:

```js
const t = Math.min(1, trace[idx[k]] * 1.6);
const v = t * t * (3 - 2 * t);      // crush the decaying tail, keep fresh spikes bright
```

| | before | after |
|---|---:|---:|
| resting luminance | 0.075 | **0.022** (3.4× darker) |
| peak luminance | 0.804 | 0.823 |
| **rest : peak ratio** | 10.7× | **37.4×** |

📌 **The measurement that mattered.** Sampling a live fly's trace (82,561 neurons at
sim-t 2.3 s) shows a strongly **bimodal** distribution:

| trace bin | share |
|---|---|
| 0.0–0.2 | **90.1%** |
| 0.2–0.8 | 2.4% |
| 0.8–1.0 | **7.5%** |

So ~9.2% of points render bright. Because almost nothing sits in the middle, the smoothstep
barely changes the lit fraction on its own (9.41% → 9.16%) — **darkening the floor is what
actually did the work.** The smoothstep is kept because it still suppresses the sparse
mid-range tail between spikes, but it is not the reason this worked. Useful general lesson:
with a bimodal signal, adjust the floor, not the curve.

✅ Verified on screen at 6 flies: rows show bright green speckle with visible internal
structure against near-black, each with its own rate (8.2 / 3.7 / 5.5 / 14.6 / 13.4 Hz).

📌 On a fresh load the lower rows sit dark for a second or two before filling in — that is
the round-robin poll working through the flies, not a bug.

---

## 12. Open questions for later phases

- Does `powerPreference: 'high-performance'` in `lifgpu.js:158` change the picture on the
  4050? If WebGPU on discrete silicon beats 0.043×, the whole Phase 3 calculus changes.
- Is the `steps < 8` / 8 ms cap tunable without breaking the motor loop's freshness
  assumption? The comment warns that an unbounded queue "leaves the motor reading
  increasingly old brain state".
- `MAX_FLIES = 12` is baked into the memory allocation. Raising the worker-pool cap above
  12 means touching `allocBrainMemory`, not just the pool.
- Where does per-fly cost actually go — brain, MuJoCo, or the 1442 raycasts? Needs a
  profile before Phase 4's vision toggle can be predicted rather than guessed.

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

## Where to start

| if you want… | read |
|---|---|
| to get it running | §1 setup — the blocker is not what the README implies |
| a benchmark that means anything | §2 (which GPU you are actually on) then §18 method notes |
| how many flies your machine holds | §8 ramp, §9 `?vision=0` |
| how the sim is wired | §5 worker model, four clocks, what is shared |
| the learning work | §14 mechanism, §15 results and their limits |
| every URL flag | §17 |

**State of play.** Phases 1–4 done and measured. The arena is restyled, six flies run with a
live per-fly brain panel, flies can be added, renamed and deleted, and a rule-based
ringmaster stages scenarios. Every sensory channel in the bodymap is now driven, including
two that were silent. Mushroom-body plasticity exists, is contingent on punishment, and
produces an odour-specific shift that scales with dose — but **no behavioural consequence has
been demonstrated**, and the effect sign is inverted relative to textbook aversive learning.
§15.5 states that position precisely.

⚠️ Several claims in this file were **wrong and later corrected in place** — the GPU
comparison in §2 and the temperature channel in §16.2 most notably. Corrections are marked
rather than deleted, because how they were wrong is the useful part.

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

### 8.11 ✅ `?vision=0` on the RTX 4050 — it raises the ceiling, but not the way expected

Same conditions, `?flies=12&bench=1&vision=0`, GPU confirmed `nvidia lovelace`.

| flies | per fly (vision on) | per fly (blind) | **aggregate on** | **aggregate blind** | fps on | fps blind |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0.0650 | 0.0652 | 0.0650 | 0.0652 | 165 | 165 |
| 2 | 0.0570 | 0.0828 | 0.1139 | 0.1656 | 165 | 165 |
| 3 | 0.0470 | 0.0666 | 0.1409 | 0.1998 | 165 | 155 |
| 6 | 0.0247 | 0.0387 | 0.1485 | 0.2319 | 165 | 118 |
| 9 | 0.0165 | 0.0298 | 0.1486 | 0.2684 | 107 | 92 |
| 12 | 0.0102 | 0.0226 | 0.1219 | **0.2708** | 53 | 75 |

**Aggregate ceiling rises from ~0.15 to ~0.27 — about +80%.** That is the number that
matters for recording, because it raises the *total* fly-time produced per wall-second
rather than redividing a fixed budget.

❗ **But at one fly it makes no difference whatsoever: 0.0650 → 0.0652.**

That is the opposite of the WASM path, where blinding a single fly gave **3.6×**. The
explanation is that the two backends put vision and the brain on *different* processors:

- The LIF brain runs on the **GPU**.
- Vision is **CPU** work — `mj_multiRay` over 1442 rays, plus `fv_step` over 45,669 nodes
  and 1.5 M edges in WASM.

With one fly those two overlap and the GPU brain is the critical path, so removing vision
frees a resource that was not the constraint. As flies are added the **CPU** saturates
first, and vision's CPU cost becomes the thing capping aggregate throughput. So on WebGPU
`?vision=0` is not a per-fly optimisation at all — it is purely a *scaling* one.

📌 Corollary: the ~0.15 aggregate ceiling with vision on is set by **CPU-side vision work,
not by the GPU**. Only once vision is removed does the ~0.27 ceiling appear, which is
presumably where GPU contention and the per-step `await queue.onSubmittedWorkDone()` finally
bite.

⚠️ Two honest caveats about that table:
- **fps is *lower* blind at mid counts** (118 vs 165 at 6 flies). Not a regression — the
  flies are simulating ~1.6× faster, so they post poses more often and the render thread has
  more to do. Throughput was traded for frame rate.
- **The 2-fly blind row (0.0828 per fly) is higher than the 1-fly row**, which should not
  happen. Single sample, not reproduced; treat that one row as noise rather than a real
  super-linear effect.

### 8.12 Operating points

| goal | setting | result |
|---|---|---|
| smooth live playback | 6 flies, vision on | 165 fps, 0.1485 aggregate |
| maximum recorded fly-time | 12 flies, `?vision=0` | 0.2708 aggregate, 75 fps |

An 8-hour unattended run:

- **6 flies, vision on** → ~71 min total fly-time (~12 min each)
- **12 flies, blind** → ~130 min total fly-time (~11 min each)

So blind recording gives **~1.8× more total behaviour per night** *and* twice as many
flies, at the cost of the animals navigating by odour, taste and touch alone.

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

## 12. Fly management: delete, rename, slot recycling

The project shipped with **no way to remove a fly**. No `worker.terminate()` anywhere, no
removal path, and `nextId` only ever incremented — so `MAX_FLIES` was a *lifetime* budget,
not a concurrency limit. Spawn twelve, kill them all, and you still had to reload.

`removeFly(id)` now:

1. `worker.terminate()` — nothing else stops the sim loop inside it
2. `ArenaBatches.remove(fly)` — new; calls `BatchedMesh.deleteInstance` and splices the
   entry out of `group.sources`. Without it a removed fly keeps its instance slots forever
   and the batch fills up after `capacity` spawns even though flies have been deleted
3. disposes meshes and the ground ring, frees the stack colour buffer
4. **force-pushes `others`** so the survivors stop sensing a ghost proxy
5. returns the slot to a free list

⚠️ **Slot reuse is only safe because both brain backends clear state on construction** —
`LIFWasm.reset()` runs in its constructor, `LIFGpu` allocates fresh buffers, and `FlyVis`
rewrites `v` from bias. A new fly in a recycled slot does not inherit the old one's
membrane potentials.

📌 The stack panel had to be **rekeyed by slot** rather than array position, or rows shuffle
when a fly in the middle is deleted.

`FLY_LIMIT = 6` is a hard ceiling independent of `MAX_FLIES` and `?flies=`.

---

## 13. Janus — the rule-based ringmaster

`src/ringmaster.js`. Not a model: no network, no API key, ~250 lines of pattern matching
over written text. On by default with the circus theme; `?ringmaster=0` disables.

**What it can see:** only the pose message each worker posts at 30 Hz — `behavior`,
`energy`, `health`, `pos`, `flying`, `alive`. It has no access to neurons.

**Three timers.** `watch()` every 400 ms reacts to behaviour *transitions*, so a fly walking
for a minute produces one line rather than 150. `idle()` every 6 s fills silence.
`runAdventure()` restages the arena every 75 s.

`say()` rate-limits to 4.2 s (900 ms for priority), refuses to repeat the previous line, and
scales its hide timer to text length. Priority is why a death interrupts idle chatter.

**Adventures are data** — `{name, line, apply(env), restore?, threat?}`. Each rewrites `env`,
then calls `rebuildEnv()` **and** posts to every worker. Two separate paths: miss the second
and the arena *looks* changed while the flies never learn of it.

⚠️ **Never stages obstacles.** `clearance()` reads `env.obstacles` live, but the MuJoCo world
is built at fly creation — so a new obstacle would be *sensed* by existing flies while not
physically existing for them.

⚠️ **It mutates `env` on a timer, so `?ringmaster=0` for any benchmark.**

📌 **It deliberately never uses the `stimulate` hook.** The workers accept
`{type:'stimulate', indices, rate}`, which could drive named circuits directly. Not using it
is what keeps every behaviour it comments on a genuine result of the simulated brain.

---

## 14. Mushroom-body learning

### 14.1 Why an overlay, and why it is cheap

Learning must be private per animal, but the connectome is shared — that sharing is what
makes a fly cost state rather than another 40 MB of graph. It does not need duplicating: in
*Drosophila*, associative memory lives at the Kenyon-cell to MBON synapse, and here that is

| | |
|---|---:|
| total edges | 10,511,038 |
| KC to MBON edges | **44,042** (0.419%) |
| surviving `minSyn` with non-zero weight | **29,169** |
| per-fly overlay (float32) | **114 KB** |
| vs duplicating the graph | 40 MB per fly |

The full circuit is present: **4,064 Kenyon cells, 97 MBONs, 340 dopaminergic neurons
(PAM/PPL/DAN), 2 APL**.

### 14.2 Why a trace rule, not spike pairs

The default backend batches. `LIFGpu.step()` returns the **previous batch's** fired list,
capped at 65,536 — so a per-step spike list does not exist on the backend most people run.
`trace` (tau 30 ms) *is* read back every batch on both backends, so the rule is
eligibility-trace x dopamine, which is also the standard formulation for this circuit.

### 14.3 Compartments from connectivity, not names

A DAN teaches the synapses of the compartment it innervates, so "same compartment" is taken
directly as "this DAN synapses onto this MBON". Covers **96 of 97 MBONs and 334 of 340
DANs**, median 5 DAN edges per MBON.

📌 Name parsing would have failed outright — the types are opaque (`MBON01`, `PPL202`) with
no compartment in the string.

### 14.4 Four faults found by measuring, not reading

Every one produced plausible numbers:

1. **Tonic dopamine.** These DANs fire constantly (~39 summed trace at rest). Learning from
   the absolute level depressed everything any active KC touched — ~2,700 edges in one
   simulated second. That is decay, not association.
2. **One time constant.** `trace` decays in 30 ms so the summed drive swings ~70% step to
   step. An earlier "30.3 +/- 12%" reading was sampled at 4 Hz *through the pose message* —
   the sampling was smoothing the very noise the rule then had to survive.
3. **Priming on one sample.** Seeding baselines at t=0, when the brain has barely spiked,
   left a permanent 250%+ apparent burst; the fly learned its own startup transient.
4. **Wrong detector.** The gate ran on the MBON-weighted, *normalised* sum while the clean
   separation had been measured on the plain summed DAN trace. Normalising destroys it —
   punishment then read as a 20% *fall*.

Final shape: dopamine low-passed to ~300 ms against an 8 s tonic reference, both seeded from
an average over a settled window (1.2–4.0 s), gated globally and weighted per compartment.

### 14.5 ⚠️ The experiment that killed the animal

A radius-2.4 hazard at `heat: 1.0` drains health in ~2 simulated seconds, and
`FlyAgent.step()` early-returns once `alive` is false — so the brain stops and dopamine
decays. Two "punished" readings came from a **corpse** before anyone noticed.

`heat: 0.5` is exactly the damage threshold (`if (st.heat > 0.5)`): full nociceptive drive,
no harm. **Always log `health` alongside any punishment result.**

### 14.6 Measured: punishment does reach the dopaminergic system

| condition | summed DAN trace (min / median / max) |
|---|---|
| no heat | 27.07 / **30.28** / 34.57 |
| heat | 42.71 / **50.94** / 56.66 |

+68% median, distributions **not overlapping**.

---

## 15. Differential conditioning — what it did and did not show

`public/conditioning.js`, loaded by `?cond=1`. CS+ **vinegar**, CS− **geosmin** — chosen
because they share **no glomeruli**. (Banana would have been a poor control: it overlaps
vinegar on 4 of its 7.) Learning frozen during all four probes so they read the memory
rather than writing to it.

### 15.1 The readout had to be split

A summed MBON population cannot test the hypothesis: MBONs have opposing valences and
summing discards the balance the question is about. Two splits, both derived from data:

- **`mbonSign`** — transmitter: 50 cholinergic (excitatory) vs 47 glutamatergic/GABAergic
- **`mbonClass`** — 57 PPL1-innervated (aversive) vs 38 PAM-innervated (appetitive)

### 15.2 Dose-response, 4 replicates per condition

| readout | control (0x) | 1x dose | 9x dose | trend | t(9x vs ctrl) |
|---|---:|---:|---:|---|---:|
| all | +4.0±7.1 | +3.2±4.9 | +5.8±3.8 | — | 0.44 |
| excitatory | +7.6±11.9 | +13.2±5.8 | +17.5±4.5 | rising | 1.55 |
| inhibitory | +1.8±5.0 | −2.8±5.6 | −0.6±3.7 | — | −0.78 |
| aversive cmpt | +7.5±8.8 | +9.0±7.5 | +12.4±5.2 | rising | 0.97 |
| **appetitive cmpt** | +0.6±7.0 | −2.5±3.6 | −0.6±3.4 | — | −0.29 |
| **exc/inh ratio** | +5.5±7.6 | +16.7±6.1 | +18.1±3.1 | **rising** | **3.09** |
| **aver/appet ratio** | +6.8±2.2 | +12.8±4.7 | +13.6±2.3 | **rising** | **4.25** |

Four readouts rise monotonically with dose, spread *shrinks* as dose rises, and the
appetitive compartments — which punishment dopamine should not touch — show no trend in any
condition.

### 15.3 What the control taught

⚠️ **A single pair of runs was misleading.** With n=1 the aversive-compartment effect looked
like **+13.6** attributable to plasticity. With repeats it is **+1.5, t=0.25** — the control
produces nearly as much as the learning run. A plasticity-free brain still separates CS+
from CS− by 5–11 points, because the two odours are not equivalent stimuli and pre/post
ordering is not neutral.

📌 The control also needed a fix before it was one: the protocol calls `setLearn(true)`
before training, which overrode `?learn=0`. A control that silently isn't one is worse than
no control. Confirmed working by `depressed per fly: 0, 0, 0, 0`.

### 15.4 ⚠️ Pseudo-replication

The four "replicates" are four flies **in one arena**. They sense each other as proxies and
share an olfactory field, so their noise is correlated. This inflates confidence; the t
values above are optimistic. Genuinely independent seeds need separate runs at ~4x the cost.

### 15.5 Honest position

**Supported:** a plasticity-dependent, odour-specific shift in the MBON valence balance that
scales with learning dose.

**Not supported:** that it corresponds to avoidance behaviour.

The sign is *inverted* relative to textbook aversive learning — the punished odour drives the
aversive compartments **more**, not less. Consistent with disinhibition: Kenyon cells are
cholinergic, so depressing KC drive onto an *inhibitory* MBON releases whatever it was
suppressing. Inhibitory MBONs fell while excitatory ones rose, which is that signature.

📌 Dose landed on **depth, not extent**: 9x the drive gave only ~6% more depressed synapses
(4503 vs 4249) but roughly doubled mean depression (0.11 vs 0.05). The count saturates
because only KCs active during training can be depressed, and they are nearly all hit.

---

## 16. Sensory channels — two were silent

The bodymap maps every channel onto real connectome neurons. Two were never driven by any
code path.

### 16.1 Courtship song to Johnston's organ ✅ wired

**114 auditory neurons (62 left, 52 right)** sat at exactly zero while males *did* sing
(`intrinsic.courtSing`, behaviour label `singing (courtship)`). The flies sang and nothing
heard.

Song is **near-field particle velocity**, not pressure, with two consequences modelled
rather than fudged:

- falls off ~1/r^2, so it is a courtship signal over **millimetres** (`rangeCm` 0.6, about
  two body lengths) rather than a broadcast
- **directional**, because the antennae sit apart — so distance is measured from *each
  antenna separately* and the bilateral difference falls out of the geometry

The ~250 Hz carrier is far above a 1 ms step, but the **pulse train** is not, and the
inter-pulse interval is the species-recognition cue: 10 ms pulses at 35 ms intervals.

| condition | JO auditory L | R |
|---|---:|---:|
| male, nobody singing to him | 0 | 0 |
| female, male silent (5 samples) | 0 | 0 |
| **female, male singing** | **0.030** | **0.089** |

Asymmetric with him on her right. The male's `JO wind/gravity` reads 0.26 in the same probe,
so the silence was specific to the auditory channel, not a broken measurement.

📌 Song range (0.6 cm) comfortably exceeds the distance at which singing starts
(`Intrinsic.courtSing` = 0.45 cm), so a female is always within earshot of a singing male.
Those two numbers were set independently and happen to be consistent.

### 16.2 Humidity ✅ wired — temperature was already done

⚠️ Correcting an earlier guess: **temperature was never broken.** `thermosensory` L/R (25
neurons) is driven by `heatAt` at each antenna. Only `hygrosensory` L/R (**65 neurons**) was
dead.

Every food patch already carries a `water` fraction, so moist food is the vapour source:

| position | humidity |
|---|---:|
| on the moist food patch | 0.550 |
| 1 cm away | 0.489 |
| far corner | 0.450 (ambient) |
| on the patch, hot floor | **0.200** (dried below ambient) |
| on the patch, 14 cm/s wind | **0.472** (excess mixed away) |

The bodymap pools moist and dry cells into one group per side, so only the moist response is
modelled — and it is driven by the rise **above ambient**, not the absolute level. A gradient
is what a fly can navigate; a constant ambient would pin all 65 neurons at a fixed rate
forever.

Verified: hygrosensory 0 / 0 away from water, **0.508 / 0.520** on moist food, with
thermosensory at 0 in both (no hazard) — the two antennal channels stay independent.

---

## 17. The full flag surface

| flag | effect |
|---|---|
| `?env=<preset>` | `foraging`, `openfield`, `predator`, `maze`, `social`, `courtship` |
| `?flies=N` | worker-pool cap, clamped to `FLY_LIMIT` = 6 |
| `?gpu=0` | force the WASM brain kernel |
| `?vision=0` | blind flies — skips raycasting and flyvis |
| `?theme=lab` | original muted arena instead of the circus |
| `?ringmaster=0/1` | Janus off/on (default on with the circus theme) |
| `?learn=0` | fixed-weight brain, no mushroom-body plasticity |
| `?eta=X` | multiply the learning rate (dose-response) |
| `?persist=0` | don't save or restore flies (use for any benchmark or controlled run) |
| `?dafloor=X` | phasic-dopamine gate threshold (default 0.15); ALWAYS pair with an unpunished control |
| `?noci=1` | nociceptive afferents onto PPL1 (OFF by default; an addition beyond the connectome) |
| `?props=0` | stage the ring with the staircase alone (for obstacle-cost comparisons) |
| `?cond=1` | run the differential-conditioning probe |
| `?train=N` | training seconds for that probe |

---

## 18. Method notes worth keeping

These cost real time and are not obvious from the code.

- **Check which physical device a benchmark runs on.** The adapter string is one line of
  JavaScript. `chrome://gpu` does *not* answer it — it lists every adapter present.
- **Background tabs throttle the workers.** Chrome throttles `setTimeout`, and the sim
  dropped from 0.102 to 0.018 sim-s/s when the tab lost focus. Any timed protocol needs the
  window in front.
- **`animate()` early-returns on `document.hidden`**, so rendering stops in a hidden pane and
  `#fps` reads 0. Sim-only numbers are right for headless goals and optimistic for playback.
- **Log the animal's health alongside any punishment result.** A dead fly stops stepping and
  every downstream signal decays.
- **A dynamic `import()` of a file in `public/` is not in Vite's module graph** — the
  transform fails and the whole inline script 500s with no visible error. Inject a tag.
- **Compare at matched *simulated* time, not wall time.** A startup transient made one
  circuit read 86 Hz where its settled value was 4 Hz.
- **A preview tab that stops responding is usually a dead CDP connection, not memory.** A
  fresh tab costs seconds; retrying navigation on the dead one costs 5 minutes per attempt.
- **A control that can be silently overridden is not a control.** Verify it took effect from
  inside the run, not from the URL you typed.

---

## 19. Janus made physical — the red orb

Janus used to be a disembodied banner. It is now a red glowing orb that appears in the ring,
and the point of the exercise was that **the flies actually see it** rather than it being
scenery drawn over the top.

**How it is wired.** One definition reaches both renderers:

- `world.js` gives every fly's MuJoCo world a non-colliding `janus` mocap sphere (r = 0.16 cm),
  parked at z = −20 until placed, in `group="0"` — the ray group `FlyVisionFV.groups` casts
  against.
- `fly.js` classifies its geom as `'janus'` and gives it an *emissive* albedo: the sky is
  divided out, so the orb stays the brightest surface in the ring even with the lights down.
- `arena.js` mirrors the orb's position into every worker at 20 Hz. flyvis resamples at 50 Hz,
  so that is faster than the eye can resolve.

**Measured, not assumed.** A `probe` message on the fly worker reports the janus geom id, its
mocap position, its albedo, and how many of the 1,442 eye rays currently land on it:

```
before:  gid 93, kind "janus", mocap [0, 0, -20],      albedo 0.950, hits 0
after:   gid 93, kind "janus", mocap [0.90, 0, 0.22],  albedo 1.175, hits 46
```

Through the live pipeline, 23 of 24 one-second samples had the orb in the fly's eye rays, 9–43
rays at a time.

> ⚠️ **I got this wrong twice before the probe existed.** An eye-image diff appeared to show
> 48 columns changing when the orb was placed — that was the fly's own head motion between
> samples, not the orb. A later test pinned the orb 0.9 cm in front of the fly's *starting*
> heading and then let the fly walk away from it, producing a "no effect" reading that was
> equally wrong. Counting ray hits inside the worker is the only measurement here that does
> not depend on where the fly happens to be looking.

**Brightness is not a graded code.** A sweep showed that below about 0.9 the orb is lost
against the pale floor squares (albedo 0.92). It now sits above that at all times, so what the
flies get is its **arrival and departure** — `glow` carries the fade ramp, so a bright object
grows in and dims out over a few hundred ms. That is a transient of the kind the lobula
columnar cells respond to. It is not a brightness signal they can read a value from, and the
code says so.

**It is an event, not furniture.** Three gates keep it from becoming scenery:

| gate | value | why |
|---|---|---|
| priority | ≥ 1 | adventures, behaviour reactions and commands summon it; idle musings do not |
| `maxStay` | 11 s | a chatty stretch cannot hold it in the air indefinitely |
| `cooldown` | 16 s | after it leaves, the ring stays empty for a while whatever Janus says |

Ungated, with two flies it was present 29 s out of 34. Gated: one 13 s visit, then 30 s clear.

> ⚠️ **The orb must not be driven by the render loop.** `animate()` early-returns on
> `document.hidden`, but the fly workers keep simulating. Driven by rAF alone, a backgrounded
> orb freezes in mid-air and every fly goes on seeing a bright stationary object indefinitely —
> which would quietly contaminate exactly the long unattended runs this is for. It is driven by
> a 100 ms interval *and* the render loop, integrating on measured elapsed time, so extra calls
> only make it smoother.

Also worth knowing: **`document.hidden` is not reliable in the embedded preview pane.** Inside
a rAF callback it read `false` while a `setTimeout` in the same document read `true`, in the
same second. Don't build correctness on it.

**Two units mistakes worth remembering.** The arena is 2.5 cm across and THREE's lights are in
candela: a `PointLight(colour, 2.2, 4.0)` washed the entire set red. And a `MeshStandardMaterial`
with a high `emissive` plus `toneMapped: false` drives the bloom straight to white, so the orb
rendered pink. It is now an unlit `MeshBasicMaterial` with an explicit red ramp, and the
brightness is carried by two additive shells.

---

## 20. Persistent flies — one saved brain per animal

Flies now survive closing the page. Reopening restores the animals you had, with what they
learned, instead of a fresh naive cast.

**What is actually saved.** The connectome is *shared* — one SharedArrayBuffer of 165,122
neurons and 10.5M edges read by every worker, which is the whole reason several flies fit in a
browser. Duplicating it per fly would cost ~40 MB each. What genuinely differs between two
flies is the learned part: the mushroom-body plastic overlay, one depression value per KC→MBON
edge. **29,169 floats, 114 kB.** That array *is* the animal's individuality, and it is what
gets written.

Membrane potentials, the physics world and the connectome are not saved. None of them is what
makes one fly different from another, and all three rebuild in under a second.

| operation | effect on the store |
|---|---|
| add a fly | prompts for a name, creates a record under it (or offers to bring back an existing one) |
| rename | moves the record — the name *is* the key |
| delete | deletes the record for good |
| every 20 s, and on `pagehide` | writes any brain that has actually learned something |

**Verified end to end**, and not by trusting the save path: a recognisable pattern (every 100th
edge depressed to 0.5) was planted in the store, the page reloaded, and the weights pulled back
out of the **running worker's** `MushroomBody` — 292 non-zero edges at exactly the planted
indices. Rename/add/delete were each checked against the store listing afterwards.

> One honest gap: I have not yet demonstrated *naturally learned* weights surviving a reload.
> In 44 s of wall time only ~1 s of simulation elapsed, and the mushroom body has a 4 s warm-up
> before it will learn at all. The mechanism is proven; the biology needs a long run.

**IndexedDB, not files.** A web page cannot write to arbitrary paths on disk. The store is
keyed by fly name, so it behaves like a folder of files named after the flies; the ⇩ button on
each fly row and the "⇧ Load fly" button export and import real `<name>.naf-fly` files (a JSON
header followed by the raw Float32 array) when you want them on disk.

**Two guards that matter:**

- *Signature check.* Weights are stored with `nEdges:nKC:nMBON`. If the connectome or the
  minimum-synapse threshold changes, the saved array indexes a different edge list; loading it
  would scramble every learned weight. The identity is kept, the brain is dropped, and it says
  so.
- *Single owner.* Two tabs of this app share one IndexedDB. Without a guard both restore the
  same flies at startup and both write back on their own timers, so each tab's autosave
  silently overwrites the other's animals. The first tab claims the store over a
  `BroadcastChannel`; later tabs run normally with persistence off. **This was not theoretical
  — stale tabs left open during testing resurrected a deleted fly.**

> ⚠️ **Use `?persist=0` for any benchmark or controlled run.** A fly that remembers the last
> experiment is not a naive subject, and a restored cast is not the preset's cast.

---

## 21. Trying to show learned weights survive a reload — and why it failed

The persistence mechanism is proven (Section 20). Showing *naturally learned* weights surviving
a reload is not, and the reason turned out to be a property of the model rather than a shortage
of patience.

### What the gate needs

    popFast   300 ms smoothing of the summed DAN trace
    popBase   8 s slow reference that popFast is compared against
    popRel    (popFast - popBase) / popBase
    gate      (popRel - phasicFloor) * phasicGain,  phasicFloor = 0.15

Learning happens only while `gate > 0`.

### Three protocol errors, all mine

1. **Constant punishment teaches nothing.** Heat on from t = 0 and left on for 22 s sim gave
   `dan` 47.8 (elevated), `kc` 316, `popRel` 0.063, `gate` 0, zero edges changed. An 8 s
   reference absorbs a constant level. The heat was also on *during* the 4 s warm-up, so both
   references seeded at the punished value. This is the rule working as designed — it ignores
   tonic dopamine, which is exactly why it was written that way.

2. **An 8 s reference needs far more than 10 s to forget.** Clearing the heat and waiting ~10 s
   sim before pulsing bouts gave `popRel` peaks of 0.073: `popBase` had decayed only ~70% of the
   way back. After sustained punishment, allow several multiples of `popBaseMs` before treating
   the next onset as clean.

3. **Predicting a threshold crossing from a slope.** I reported popRel was "rising ~0.06 per
   0.4 s with 1.5 s left, so it should cross". It plateaued at 0.073 and fell back. `popFast` is
   a 300 ms exponential approaching a ceiling, not a ramp; its early slope says nothing about
   where it lands.

### The real finding: rest and punishment are not separable

Fresh page load, references seeded at rest during warm-up, odour throughout, 6 s of rest, then
heat on:

| condition | peak `popRel` | gate |
|---|---|---|
| rest (point sample) | 0.002 | 0 |
| punished, heat 0.5 | 0.111 | 0 |
| punished, heat 1.0 | 0.099 | 0 (and health fell to 0.65) |

Doubling the punishment did not raise the response — **the nociceptive drive saturates**, so
punishment strength is not a lever.

Then, on instruction, the floor was lowered to 0.05 and run *with an unpunished control first*:

    control, 8 s, NO punishment:
      popRel   median 0    p90 0.056    max 0.108
      gate fired on 17 of 145 samples, peak 0.127
      edges depressed: 1,094

> ⚠️ **The control is the whole result.** 1,094 edges depressed with nothing happening at all.
> Unpunished `popRel` maxes at 0.108; punished peaks at 0.111. There is essentially no
> separation, so no threshold can distinguish them. Lowering the gate does not produce learning
> — it reproduces the original tonic-dopamine bug, which is precisely what the floor exists to
> prevent.

> ⚠️ **I justified the 0.05 floor with a bad measurement.** I claimed rest "sits at 0.002, so
> 0.05 is 25x above resting noise". That came from a single point sample. The resting
> *distribution* reaches 0.108. Characterise a noise floor with a distribution, never one
> sample — and never set a threshold from the one sample.

The default stays at **0.15**, which sits just above resting noise and is correctly placed.
`?dafloor=X` exists to experiment, and any value used must be checked against an unpunished
control or it is measuring nothing. The open problem is upstream: punishment does not produce a
dopamine response distinguishable from rest in this build.

### Throughput measured in the embedded Browser pane

    vision off, tab fronted   0.031x
    vision on,  tab fronted   0.0068x

`requestAdapter()` reported **"intel"** — the pane runs on the integrated GPU. The
`GpuPreference` registry fix applies to `chrome.exe`, not to this Electron binary, so the 0.065x
figure from real Chrome does not transfer. Check the adapter string before trusting any rate.

---

## 22. Every fly's eyes, not just the selected one

The brain panel showed one pair of 721-column luminance maps while the neural stack beside it
showed every fly — visibly inconsistent, and the fix was nearly free.

The activity poll was **already** round-robin across every fly; each reply carries that fly's
`lumEye` pair. Only the selected fly's was being drawn and the rest were discarded. Now each fly
gets its own labelled row, painted from its own reply, and clicking a row selects that fly. No
extra message traffic.

The heavy work — the 165k-neuron trace into the rotating inset, and the per-group Hz history —
stays selected-only, because that is the part that actually costs something.

> Note for testing: the poll returns early when `document.hidden` is true **or** the brain panel
> is folded, and the fold state persists across reloads. A blank eye panel during testing is
> usually a folded panel from an earlier session, not a bug. Posting `{type:'activity'}` to the
> workers directly bypasses both and is the way to verify the draw path.

---

## 23. Janus restages the world, and something hunts

### Environments

`LOOK` was a `const` chosen once by `?theme`. It is now a `LOOKS` registry — `circus`, `lab`,
`dungeon`, `cavern`, `lab2` — and a mutable `LOOK`, with `setLook(name)`.

`rebuildEnv()` already regenerates the floor texture, wall, bunting, tent and props from `LOOK`,
so changing `LOOK` and rebuilding restages the whole set. The line that matters biologically is
the last one: `setLook` posts the new `albedo` block to every worker, so **a dungeon is genuinely
darker to the flies' photoreceptors than the big top was**.

| look | floor albedo | wall albedo |
|---|---|---|
| circus | 0.06 – 0.92 | 0.29 – 0.77 |
| dungeon | 0.10 – 0.26 | 0.06 – 0.16 |
| cavern | 0.07 – 0.22 | 0.04 – 0.13 |
| lab2 | 0.72 – 0.91 | 0.45 – 0.68 |

A look change also clears `fv.settled`, so the optic lobe re-settles against the new scene
instead of reading the swap as one enormous transient.

Three new adventures use it: **The Dungeon** (pillars, a back wall, food at the far end),
**The Sunken Cavern** (damp — humidity 0.9, which the hygrosensory channel actually reads), and
**The Beast**. Commands: `dungeon`, `cavern`, `monster`.

### The monster

A dark mass that pursues the nearest living fly. Like Janus it is a real mocap geom in every
fly's world so the eye rays hit it; unlike Janus its albedo is **0.04**, so it reads as a dark
shape growing in the visual field.

Crucially it does not get its own bespoke escape hook. While hunting it drives `env.threat`
whenever it is within 1.1 cm of a fly, which is the *existing* looming channel into DNp01 and
the giant-fibre reflex. The flies flee it through the pathway a real looming predator would use.

Measured, one fly, samples 2.5 s apart:

    dist (cm)   2.25  2.19  2.10  2.05  2.00  1.96  1.87  1.83  1.79  1.74
    eye rays       7     7     7     8     8     8     9     9     9    11

Distance falls monotonically (it chases) and the ray count rises as it closes (it looms). That
growth *is* the stimulus — a dark object subtending an increasing solid angle.

It is non-colliding on purpose: a kinematic body shoved through the solver at a walking fly is a
good way to wedge the contact solver. It eases to 15% speed within 0.22 cm so it stalks rather
than jittering through its target, is clamped inside the wall, and is recalled automatically at
the end of its hunt and before any scene change — `recallMonster()` runs at the top of
`runAdventure`, so a beast is never left loose across a restage.

---

## 24. The punishment signal, fixed — and learning that survives a reload

Section 21 ended blocked: aversive stimuli raised dopamine ~11% where the phasic
gate needs ~68%, and lowering the gate only let noise through. The cause was not
a constant anywhere.

### The neurons that carry "this hurts" are not in the dataset

Measured on the graph directly, no simulation needed:

    thermosensory -> PPL    0 direct edges,  103 two-hop paths via 46 intermediates
    gustatory     -> PPL    0 direct edges,   89 two-hop paths via 49 intermediates
    PPL 24 neurons          PAM 316 neurons

The 25 "thermosensory" neurons are arista cells, which report *preferred*
temperature (Gallio et al. 2011). They are not nociceptors. Noxious heat and
mechanical nociception in Drosophila are carried by class IV multidendritic
neurons, which are peripheral and therefore almost entirely outside a
central-brain EM volume.

So the route exists but is far too thin: 25 cells, already firing at 100 Hz at
heat 0.5, reaching 24 PPL neurons over 103 two-hop paths. Nothing tunable was
going to move that.

> Also note PPL is 24 of 340 DANs -- 7%. A detector summing all dopamine dilutes
> a real punishment burst by the 316 PAM neurons reporting nothing bad. The
> detector now runs on the PPL subset (`danClass`), which is correct on its own
> terms but was NOT the blocker.

### The fix: supply the afferent, flagged and controlled

`senses.js bindNociceptors` drives the PPL1 cluster from noxious intensity (heat
or bitter, through a Hill function). Same category as the giant-fibre -> TTMn
electrical synapse the project already adds explicitly because a chemical
connectome cannot contain it: a sensory channel the volume does not cover, not a
circuit being puppeted.

**OFF by default (`?noci=1`).** It is an addition beyond the connectome and every
result depending on it has to say so. The `NOCI` constants are documented as
chosen, not fitted.

### Validated against its own control

Weights zeroed AFTER settling, then undisturbed rest before any punishment:

| phase | depressed | avRel | gate |
|---|---|---|---|
| quiet rest | 0 | -0.020 | 0 |
| quiet rest | 0 | -0.028 | 0 |
| quiet rest | 0 | -0.021 | 0 |
| punished | 3,704 | 0.142 | 0.311 |
| punished | 4,068 | 0.109 | 0.239 |
| punished | 4,176 | 0.106 | 0.232 |

Health 1.00 throughout. Zero at rest, 4,176 under punishment.

> ⚠️ An earlier run of this showed 544 edges "at rest". Those accrued during the
> post-warm-up settling transient, not during rest -- which is why the control
> resets the weights *after* settling. Reset before settling and you measure your
> own startup.

### Learning that survives a reload — the original goal, finally met

    naive fly                       0 edges
    2.5 s sim punishment        3,887 edges, gate 0.39, health 1.00
    saved                       4,096 non-zero, checksum 1833.1076
    -- page reload --
    read from RUNNING worker    4,096 non-zero, checksum 1821.4132, same indices

Same edge count, same indices, `restored: true`. The checksum is 0.6% lower
because the memory is *decaying*: the mushroom body has a 120 s recovery
constant, and a fraction of a second of simulated recovery passed between the
worker seeding the weights and the read-back.

The proof that this is decay rather than corruption is the ratio: the checksum
fell by 0.99362x and the maximum depression fell from 1.00000 to 0.99362 -- the
same factor to five decimals, i.e. a uniform multiplicative decay across every
edge. A partially written or misaligned array would not decay uniformly.

### A throughput trap that cost most of a session

The embedded Browser pane is throttled hard whenever it is not the foreground
surface. Measured on the same page minutes apart:

    actively polled      0.0366x
    left alone           0.0009x   (~40x slower)

So `sleep 600` in a shell is the *worst* way to wait for a browser run: the pane
backgrounds and the workers throttle. Polling the page every ~35 s keeps it
awake and is dramatically faster in wall time. Several "this is taking forever"
stretches this session were this, not the simulation.

---

## 25. Defensive arousal — a null result, and why the design was wrong

Can a fly feel anything? Not answerable. Anderson and Adolphs (2014) propose
testing measurable properties instead -- valence, persistence, scalability,
generalisation -- and Gibson et al. (2015) showed Drosophila have a defensive
arousal after repeated looming that outlasts the stimulus, scales with sweeps,
raises locomotion and suppresses feeding.

`public/arousal.js` (`?arousal=1`) runs that paradigm. It needs no dopamine
teaching signal, so it was askable while conditioning was still blocked.

### First, a bug that would have invalidated everything

`launchThreat()` animates on WALL-CLOCK time -- a ~350 ms swoop. At 0.037x that
is **13 ms of the fly's own time**: not a looming stimulus, barely a flicker.
The monster has the same property. The harness now steps the object toward the
head over a fixed span of SIMULATED milliseconds, quadratically, so angular size
accelerates toward contact the way a real approach does.

> Anything timed for the fly must be expressed in simulated time. Wall-clock
> animation is for the viewer.

### The result

    condition   base speed    post +2s   post +4s   (relative to own baseline)
    0 passes    0.422 cm/s      1.45       1.23
    2 passes    0.737 cm/s      0.83       1.93
    6 passes    1.495 cm/s      0.50       0.84

No persistence, no dose-response. The CONTROL shows the largest immediate
elevation and six passes shows a decrease.

### Why it is uninterpretable, not merely negative

The baselines: **0.422 -> 0.737 -> 1.495 cm/s**, a 3.5x range, rising
monotonically in exactly the order the conditions ran.

1. **Order confounded with time.** Conditions ran 0, 2, 6 ascending on one fly,
   no washout, no counterbalancing. Normalising to each condition's own baseline
   does not rescue it -- dividing by a climbing baseline manufactures a falling
   trend.
2. **Underpowered.** n = 1, and the unpunished control alone swings 1.45x
   spontaneously. Any real effect must clear that.
3. **Windows too short.** Walking and feeding are bouty; 2 s bins sample bout
   phase more than state.

> ⚠️ The 0-pass control is the only reason this was caught. Without it a 1.45x
> post-stimulus elevation reads as textbook defensive arousal. Every one of these
> behavioural measures needs a no-stimulus control run in the same session.

### A hypothesis, not a result

Baseline activity rising monotonically across conditions is what carryover
arousal would look like -- each condition starting more aroused from the previous
one's looms. It is equally explicable as energy drift. This design cannot
separate them, which is an argument for washout and randomised order rather than
a finding.

### What a real version needs

- randomised or counterbalanced condition order
- several independent flies (separate workers = different brain seeds)
- washout between conditions, checked by return to a common baseline
- longer windows, sized against the bout structure rather than convenience

---

## 26. Furnishing the arena makes it FASTER

After staging the carnival (31 extra obstacles, 25 -> 56), the obvious worry was
throughput: every obstacle is a collision geom in every fly's MuJoCo world and is
walked by `clearance()` each sensory tick. The measurement says the worry was
backwards.

### How to measure it at all

`buildWorldXML` bakes obstacles into each fly's model **at creation**. Mutating
`env.obstacles` afterwards changes `clearance()` and the render but NOT the
physics, so an in-session A/B measures almost nothing. `?props=0` exists so the
two arrangements can be compared across separate page loads.

Protocol: one page load per cell, one warm-up window discarded, then repeated
20 s windows, median reported. One fly, circus theme, same everything else.

### The 2x2

| | vision ON | vision OFF |
|---|---|---|
| props ON (56 obstacles) | **0.0302** | 0.0399 |
| props OFF (25 obstacles) | **0.0177** | 0.0445 |

    props ON,  vision ON    0.02854  0.02999  0.03039  0.03054
    props OFF, vision ON    0.01744  0.01740  0.01774  0.01775
    props ON,  vision OFF   0.03964  0.04129  0.03979
    props OFF, vision OFF   0.04452  0.04134  0.04505

Variance within a cell is ~1%, so none of this is noise.

### The direction flips with vision

- **vision OFF**: the 31 extra obstacles cost **~10%**. That is the honest
  physics + `clearance()` overhead, and it is small.
- **vision ON**: the same obstacles make the sim **1.7x FASTER**.

**Mechanism: ray termination.** Each fly casts 1,442 rays per sample through
`mj_multiRay`. In an empty ring those rays run to the wall or out to the 50-unit
cutoff; in a furnished one many hit a crate or table within millimetres and
return. Clutter shortens rays, and ray casting dominates per-fly cost.

Behaviour rules out the alternative: the fly travelled *further* with props
(0.6-1.47 cm/s) than without (0.34-0.74 cm/s). More walking would predict more
physics cost, not less, so the ray effect is swamping it.

> Practical consequence: an empty arena is the *expensive* case, not the cheap
> one. Benchmarks run in a bare ring overstate the cost of vision, and stripping
> scenery to "speed things up" does the opposite.

### Two earlier attempts at this, both wrong

1. Mutating `env.obstacles` mid-session and re-measuring -- measures sensing and
   rendering only, since physics geoms are already baked.
2. Reading the resulting negative cost as a `rebuildEnv()` GC artefact. It was
   not an artefact; it was this effect showing through, and the dismissal was
   wrong. The clean cross-load design reproduced it at ~1% variance.

---

## 27. The fly ramp, re-run in the furnished arena

Section 26 showed clutter buys throughput, so the old ceiling -- measured in a
nearly bare ring -- was pessimistic. Re-ran the ramp with all 56 obstacles.

Protocol: one page load, flies added one at a time (addFly bakes the CURRENT
env.obstacles into each new world, so late arrivals get the full set), adaptive
resolution pinned off, two discarded warm windows then two 20 s measurement
windows per point.

    flies   per-fly    aggregate   window spread
      1     0.02254     0.02254       1.7%
      2     0.00911     0.01822       1.9%
      3     0.00787     0.02361       2.7%
      4     0.01790     0.07159        14%
      5     0.01428     0.07139       2.2%
      6     0.00869     0.05214       3.2%

### What is solid

**Aggregate throughput peaks around 4-5 flies (~0.072 sim-s/s) and 6 flies is
still well above anything in the 1-3 range.** The furnished arena comfortably
supports the 6-fly cap; nothing here argues for lowering it.

### What is NOT solid, and should not be quoted

- **The jump at 4 flies.** Per-fly rate rises from 0.0079 (3 flies) to 0.0179
  (4), and aggregate triples. Adding one fly cannot make each fly twice as fast.
  It reproduced across two independent runs, so it is not noise, but it is
  unexplained.
- **The 1 -> 2 drop.** Aggregate *falls* from 0.0225 to 0.0182 on adding a
  second fly. Also unexplained.
- **Run-to-run drift.** Six flies measured 0.0521 in the ramp and 0.0404 twenty
  minutes later at identical settings -- ~25%, which exceeds several of the
  gaps between adjacent points. The fine structure of the curve is therefore not
  meaningful; only the coarse shape is.

### A hypothesis tested and refuted

The obvious explanation for a low-fly-count anomaly is that the render loop
competes with the workers: few flies -> high fps -> less CPU for simulation.
Tested by shrinking the render target to 16x16 with six flies, making drawing
nearly free:

    normal canvas   0.04042
    16x16 canvas    0.03939      ratio 0.97

**3% difference. Rendering is not competing with the workers**, and the
hypothesis is wrong. Pinning the resolution scaler earlier was still worth doing
-- it removed a variable -- but it was not the cause either.

> Two confounds found and removed along the way, both of which had silently
> corrupted the first attempt: the adaptive resolution scaler changing render
> load between conditions, and measurement windows overlapping fly creation.
> Neither explained the jump.

### What a trustworthy ramp needs

The remaining variance is environmental -- this pane throttles hard when not
foregrounded (section 24) and drifts ~25% between runs. A ramp worth quoting
needs a headless harness outside the preview pane, several repeats per point in
randomised order, and the per-point spread reported alongside the mean.

---

## 28. The headless bench

`bench.html` + `src/bench.js`. The simulation path with the renderer removed:
connectome, workers, physics, and nothing else. No THREE import, no canvas, no
scene, no shadow maps, no brain inset, no neural stack, no fly meshes.

It exists because every number measured through `arena.html` carried three
confounds that careful windowing could not remove (sections 24, 26, 27):

1. **Rendering.** The arena's adaptive resolution scaler changes render load as
   scene cost changes, which silently varies how much CPU the workers get
   between conditions. Pinning it helped; removing rendering is better.
2. **Throttling.** A hidden tab runs the worker timers ~40x slower.
3. **Drift.** Repeats at identical settings differed ~25%, exceeding most of the
   differences being interpreted.

### It refuses to report a throttled number

A `visibilitychange` watchdog records whether the document was ever hidden during
a point, and any affected row is printed with `** TAB WAS HIDDEN -- DIRTY **`
and carries `dirty: true` in the CSV.

This is not decoration. The very first validation run came back with **both
points flagged dirty**, because the preview pane loses focus between polls.
Without the flag those numbers would have looked like ordinary results -- which
is exactly how several hours went missing earlier in this project.

### Staged identically to the arena, and it checks

The furniture builders are duplicated here rather than imported, because
importing them would drag in `arena.js` and with it THREE. Duplication is the
lesser evil, but it can drift, so setup asserts the obstacle count (56 with
props, 25 without) and logs a warning if the bench is no longer staged like the
arena. The first version quietly built 54 -- it had dropped the dais and replaced
the preset's own block instead of appending -- which the assertion now catches.

### Usage

    bench.html?flies=1,2,3,4,5,6   points to sweep
      &repeats=3                   measurement windows per point, median reported
      &window=20                   seconds of wall time per window
      &warm=2                      discarded warm windows per point
      &order=random                randomise point order, to decouple it from time
      &vision=0 &props=0 &gpu=0 &noci=1     passed through to the flies

Output ends in a CSV block: `flies,aggregate,perFly,spreadPct,dirty,dead`.
`spreadPct` is (max-min)/median across the repeats, so the noise floor is
reported next to every number rather than left to be assumed.

> `order=random` matters for the same reason the arousal experiment failed
> (section 25): running points in ascending order confounds the variable with
> time.

### What it still cannot do

Throttling is browser policy and applies to any page, so the harness detects it
rather than defeating it -- run it in a foreground window. Defeating it properly
would need Chrome launched with `--disable-background-timer-throttling
--disable-renderer-backgrounding --disable-backgrounding-occluded-windows`,
driven from Node by Puppeteer or Playwright. That is a dependency, and adding one
needs asking first.

---

## 29. The sensory periphery has no soma coordinates

Hovering the Smell or Taste group highlighted nothing in the brain inset. Not a
rendering bug -- there is nothing to render.

`showGroupInInset()` plots a group's neurons from `data.soma`, skipping any whose
position is the non-finite sentinel. Decoding `neurons.flyn` directly and counting
per class:

| class | total | with soma | % |
|---|---|---|---|
| olfactory | 2,639 | **0** | 0.0% |
| gustatory | 1,428 | **0** | 0.0% |
| thermosensory | 25 | **0** | 0.0% |
| hygrosensory | 66 | **0** | 0.0% |
| mechanosensory | 1,733 | **0** | 0.0% |
| mechanosensory (tactile) | 2,558 | **0** | 0.0% |
| unknown sensory | 1,707 | **0** | 0.0% |
| visual | 4,107 | 28 | 0.7% |
| Kenyon cell | 4,064 | 4,050 | 99.7% |
| DAN | 340 | 340 | 100.0% |
| central complex | 2,950 | 2,944 | 99.8% |

**Whole connectome: 140,024 of 165,122 have soma coordinates (84.8%). The missing
15.2% is essentially the entire sensory periphery.**

The reason is anatomical. These are peripheral neurons: their cell bodies sit in
the antenna, maxillary palp, proboscis and legs, outside the imaged volume. Only
their axon terminals are in the dataset. The encoder knows this -- `neurons.flyn`
carries an explicit `has` bit per neuron and stores NaN when absent.

> This is the SAME fact that blocked learning (section 24), seen from another
> angle. There the consequence was that noxious afferents were absent and no
> teaching signal could form; here the consequence is only that a panel cannot
> draw them. The general statement is: **a central-brain EM volume contains the
> terminals of the sensory periphery, not its cell bodies**, and anything that
> reasons from soma positions or expects afferent populations to be complete will
> be wrong in the same way.

### The fix is honesty in the UI, not in the renderer

The neurons are simulated and driven normally -- Smell shows 3,044 driven
neurons in that very panel. Only the *plot* is impossible. `buildBrainPanel` now
counts plottable somas per group and marks groups with none as "no soma", with a
tooltip explaining why, and `showGroupInInset` returns early instead of drawing
an empty highlight that looks like a fault.

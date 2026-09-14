// Mushroom-body associative memory: a per-fly plastic overlay on the KC -> MBON synapses.
//
// WHY AN OVERLAY. The connectome lives once in shared memory and every fly reads it, which is
// what makes a fly cost state rather than another 40 MB of graph. Learning has to be private to
// each animal, so it cannot write there. It does not need to: in Drosophila, associative memory
// is stored at the Kenyon-cell -> MBON synapse, and in this connectome that is
//
//     44,042 edges out of 10,511,038  --  0.419% of the graph, 172 KB per fly as float32
//
// so each fly carries its own small depression map over that slice and the shared graph is
// untouched. The rest of the brain stays shared.
//
// WHY A TRACE RULE, NOT SPIKE PAIRS. The default backend is WebGPU, and LIFGpu batches steps and
// reads spike data back asynchronously: step() returns the previous batch's fired list, capped at
// 65,536 entries. A per-step spike list therefore does not exist on the backend most people run.
// `trace` (tau 30 ms, set to 1 on a spike) *is* read back every batch on both backends, so the
// rule is eligibility-trace x dopamine -- which is also the standard formulation for this circuit.
//
// STAGE 1 (this file, as committed): the index is built, per-fly state is allocated, the hook runs
// every step and the instrumentation reports. `depress` stays all-zero, so delivery contributes
// exactly nothing and behaviour is provably unchanged. Stage 2 adds the learning rule.

/**
 * Find the KC -> MBON slice and capture the *effective* weights the kernel uses.
 * Must be called after allocBrainMemory: it reads back the post-writeGraph weight and sign
 * arrays, so the overlay cancels the kernel's own contribution exactly when fully depressed.
 */
export function buildMushroomIndex(data, memory, graph) {
  const N = data.N, E = data.E, types = data.meta.types;
  const isKC = new Uint8Array(N), isMBON = new Uint8Array(N), isDAN = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const t = types[i] || '';
    if (t.startsWith('KC')) isKC[i] = 1;
    else if (t.startsWith('MBON')) isMBON[i] = 1;
    else if (t.startsWith('PAM') || t.startsWith('PPL') || t.startsWith('DAN')) isDAN[i] = 1;
  }

  const buf = memory.buffer;
  const gIndptr = new Uint32Array(buf, graph.indptr, N + 1);
  const gIndices = new Uint32Array(buf, graph.indices, E);
  const gWeights = new Float32Array(buf, graph.weights, E);   // effective, post-writeGraph
  const gSign = new Float32Array(buf, graph.sign, N);         // s * wSyn per presynaptic neuron

  // CSR over Kenyon cells only: kcRow lists the KC ids that actually have MBON targets.
  const kcRow = [], rowPtr = [0], target = [], baseW = [];
  for (let pre = 0; pre < N; pre++) {
    if (!isKC[pre]) continue;
    const a = gIndptr[pre], b = gIndptr[pre + 1];
    let n = 0;
    for (let k = a; k < b; k++) {
      const q = gIndices[k];
      if (!isMBON[q]) continue;
      const w = gWeights[k];
      if (w === 0) continue;                       // pruned by minSyn, nothing to learn on
      target.push(q); baseW.push(w); n++;
    }
    if (n) { kcRow.push(pre); rowPtr.push(target.length); }
  }

  const sab = (Ctor, arr) => { const a = new Ctor(new SharedArrayBuffer(arr.length * Ctor.BYTES_PER_ELEMENT)); a.set(arr); return a; };
  const mbonIds = []; for (let i = 0; i < N; i++) if (isMBON[i]) mbonIds.push(i);

  // Compartments, derived from connectivity rather than from type names. In the fly, a DAN
  // modulates the KC->MBON synapses of the compartment it innervates; here "same compartment"
  // is simply "this DAN synapses onto this MBON". That covers 96 of 97 MBONs and 334 of 340
  // DANs, with a median of 5 DAN edges per MBON -- dense enough to gate learning per MBON.
  // Name parsing was the alternative and would not have worked: the types are opaque
  // ("MBON01", "PPL202") with no compartment in the string.
  const mbonLocal = new Int32Array(N).fill(-1);
  mbonIds.forEach((id, k) => { mbonLocal[id] = k; });

  const danRow = [], danPtr = [0], danTarget = [], danW = [];
  for (let pre = 0; pre < N; pre++) {
    if (!isDAN[pre]) continue;
    const a = gIndptr[pre], b = gIndptr[pre + 1];
    let n = 0;
    for (let k = a; k < b; k++) {
      const m = mbonLocal[gIndices[k]];
      if (m < 0 || gWeights[k] === 0) continue;
      danTarget.push(m); danW.push(gWeights[k]); n++;
    }
    if (n) { danRow.push(pre); danPtr.push(danTarget.length); }
  }
  // Per-MBON normaliser so a densely innervated MBON is not simply learned faster than a sparse one.
  const danNorm = new Float32Array(mbonIds.length);
  for (let k = 0; k < danTarget.length; k++) danNorm[danTarget[k]] += danW[k];
  for (let i = 0; i < danNorm.length; i++) danNorm[i] = danNorm[i] > 0 ? 1 / danNorm[i] : 0;

  // Which MBON (local index) each plastic edge lands on, so the rule can look up its dopamine.
  const edgeMbon = new Uint32Array(target.length);
  for (let k = 0; k < target.length; k++) edgeMbon[k] = mbonLocal[target[k]];

  return {
    nKC: kcRow.length,
    nEdges: target.length,
    nMBON: mbonIds.length,
    kcRow: sab(Uint32Array, kcRow),
    rowPtr: sab(Uint32Array, rowPtr),
    target: sab(Uint32Array, target),
    baseW: sab(Float32Array, baseW),
    sign: sab(Float32Array, kcRow.map(i => gSign[i])),
    edgeMbon: sab(Uint32Array, edgeMbon),
    mbonIds: sab(Uint32Array, mbonIds),
    danRow: sab(Uint32Array, danRow),
    danPtr: sab(Uint32Array, danPtr),
    danTarget: sab(Uint32Array, danTarget),
    danW: sab(Float32Array, danW),
    danNorm: sab(Float32Array, danNorm),
  };
}

export const MB_DEFAULTS = {
  eta: 0.0025,       // depression per ms at full KC trace and a full phasic dopamine burst
  danGain: 2.5,      // scales normalised dopamine into 0..1
  phasicGain: 2.2,   // scales the relative rise past the deadband into 0..1
  phasicFloor: 0.15, // measured: quiet sits at ~0.00, a hot floor drives popRel to 0.27-0.34+
  popFastMs: 300,    // dopamine acts over hundreds of ms; smooths the 30 ms spike trace
  popBaseMs: 8000,   // slow tonic reference the smoothed signal is compared against
  baseTauMs: 4000,   // how fast each compartment's dopamine baseline follows the tonic level
  recoverMs: 120000, // forgetting time constant, in simulated ms (~2 simulated minutes)
  kcEps: 1e-3,       // KC coding is sparse; skip rows below this trace
  danEps: 1e-3,
  warmStartMs: 1200, // ignore the brain's own ramp-up before sampling the tonic level
  warmupMs: 4000,    // end of the averaging window that seeds both dopamine references
};

/** Per-fly plastic state over the KC -> MBON slice. One of these per FlyAgent. */
export class MushroomBody {
  constructor(index, brain, params = {}) {
    this.ix = index; this.brain = brain;
    this.p = { ...MB_DEFAULTS, ...params };
    this.learn = params.learn !== false;
    // Depression fraction per edge, 0 = naive (full connectome weight), 1 = fully suppressed.
    this.depress = new Float32Array(index.nEdges);
    this.danDrive = new Float32Array(index.nMBON);   // phasic dopamine per compartment, recomputed each step
    this.danBase = new Float32Array(index.nMBON);    // slow tonic baseline it is measured against
    this.dirty = false;                  // set once anything is actually learned
    this.stats = { kcDrive: 0, danDrive: 0, mbonDrive: 0, phasicMax: 0, phasicPeak: 0, gate: 0, popRel: 0, edges: index.nEdges, depressed: 0, meanDepress: 0, maxDepress: 0 };
    this._acc = 0; this._sinceHouse = 0; this._primed = false; this._age = 0; this._popBase = 0; this._popFast = 0; this._warmSum = 0; this._warmN = 0;
  }

  /**
   * Phasic dopamine per compartment.
   *
   * These DANs are *tonically* active -- a summed trace around 39 across 334 neurons even with
   * nothing happening. Learning from the absolute level therefore depresses every synapse any
   * active KC touches, which saturated ~2,700 edges within one simulated second and is decay,
   * not learning. Real reinforcement is a burst *above* the ongoing rate, so each compartment
   * keeps a slow baseline and only the positive deviation teaches.
   */
  _dopamine(dtMs) {
    const { danRow, danPtr, danTarget, danW, danNorm } = this.ix;
    const trace = this.brain.trace, dd = this.danDrive, base = this.danBase;
    const g = this.p.danGain, kb = Math.min(1, dtMs / this.p.baseTauMs);

    // 1. Raw dopaminergic drive per compartment, then immediately normalised. Everything
    //    downstream works in these units -- mixing raw and normalised was a real bug here and
    //    made the smoothed signal read 268% above its own baseline while nothing was happening.
    // `pop` is the plain summed DAN trace, which is the quantity that was actually measured to
    // separate rest from punishment (30.3 at rest vs 50.9 on a hot floor, non-overlapping). An
    // earlier version gated on the MBON-weighted, per-compartment-normalised sum instead -- a
    // different quantity, and the normalisation destroys the separation: punishment then read as
    // a 20% *fall*. Normalisation still belongs on the per-compartment weighting below, just not
    // on the detector.
    dd.fill(0);
    let pop = 0;
    for (let r = 0; r < danRow.length; r++) {
      const tr = trace[danRow[r]];
      pop += tr;
      if (tr < this.p.danEps) continue;
      for (let k = danPtr[r]; k < danPtr[r + 1]; k++) dd[danTarget[k]] += tr * danW[k];
    }
    for (let i = 0; i < dd.length; i++) dd[i] = dd[i] * danNorm[i] * g;

    // 2. Warm up by *averaging*, not by sampling once. Priming from the first step is wrong
    //    twice over: at t=0 the brain has barely spiked so dopamine is near zero, and a baseline
    //    with an 8 s time constant then needs far longer than the old 1.5 s warmup to climb to
    //    the true level. Until it does, the fly sees a permanent 250%+ "burst" and learns its own
    //    startup. So collect the mean over the warmup window and start both references there.
    this._age += dtMs;
    if (this._age <= this.p.warmupMs) {
      if (this._age > this.p.warmStartMs) { this._warmSum += pop; this._warmN++; }
      else { dd.fill(0); return 0; }
      for (let i = 0; i < dd.length; i++) base[i] += dd[i];   // per-compartment sum, averaged below
      dd.fill(0);
      return 0;
    }
    if (!this._primed) {
      const inv = this._warmN ? 1 / this._warmN : 0;
      for (let i = 0; i < base.length; i++) base[i] *= inv;
      this._popFast = this._popBase = this._warmSum * inv;
      this._primed = true;
      dd.fill(0);
      return 0;
    }

    // 3. Is something bad happening? Answered at population level, where the measurement is
    //    reliable: summed over 334 DANs the trace is 30.3 (27.1-34.6) at rest and 50.9
    //    (42.7-56.7) on a hot floor -- +68%, distributions not overlapping. Per compartment it
    //    is not reliable (median 5 DAN edges, so far noisier), which is why the global question
    //    and the local one are separated.
    //    Two time constants: `trace` decays in 30 ms, so the instantaneous sum swings wildly on
    //    spike timing alone. Dopamine acts over hundreds of ms, so smooth to ~300 ms and compare
    //    that against a much slower tonic reference.
    const kf = Math.min(1, dtMs / this.p.popFastMs), ks = Math.min(1, dtMs / this.p.popBaseMs);
    this._popFast += (pop - this._popFast) * kf;
    this._popBase += (this._popFast - this._popBase) * ks;
    const popRel = this._popBase > 1e-5 ? (this._popFast - this._popBase) / this._popBase : 0;
    this.stats.popRel = popRel;

    let gate = (popRel - this.p.phasicFloor) * this.p.phasicGain;
    if (gate > 1) gate = 1;
    this.stats.gate = gate > 0 ? gate : 0;

    // 4. Per-compartment baselines keep tracking regardless, so they stay valid when the gate
    //    does open. Only the weighting is gated.
    let any = 0;
    for (let i = 0; i < dd.length; i++) {
      const level = dd[i];
      base[i] += (level - base[i]) * kb;
      const rel = base[i] > 1e-5 ? (level - base[i]) / base[i] : 0;
      const v = (gate > 0 && rel > 0) ? gate * (rel > 1 ? 1 : rel) : 0;
      dd[i] = v;
      if (v > 0) any = 1;
    }
    return any;
  }

  /**
   * Called once per simulated millisecond, after the brain has stepped.
   * Reads the trace shadow (valid on both backends) and, once depression is non-zero, injects a
   * negative correction into each MBON so the net synapse is weaker than the shared graph says.
   */
  step(dtMs = 1) {
    const { kcRow, rowPtr, target, baseW, sign, danRow } = this.ix;
    const trace = this.brain.trace;
    if (!trace) return;

    // Instrumentation. mbonDrive is the readout that matters for showing a memory: it is the
    // mushroom body's *output*, so if learning has depressed the KC->MBON synapses an odour
    // recruits, presenting that odour again should drive the MBONs less than it used to.
    let kcT = 0; for (let r = 0; r < kcRow.length; r++) kcT += trace[kcRow[r]];
    let danT = 0; for (let d = 0; d < danRow.length; d++) danT += trace[danRow[d]];
    const mb = this.ix.mbonIds;
    let mbT = 0; for (let i = 0; i < mb.length; i++) mbT += trace[mb[i]];
    this.stats.kcDrive = kcT; this.stats.danDrive = danT; this.stats.mbonDrive = mbT;

    // --- learning: coincidence of KC eligibility trace and compartment dopamine depresses the
    // synapse. Depression (not potentiation) is the established direction at KC->MBON in flies:
    // an odour that predicted punishment stops driving the MBONs that would approach it.
    const phasic = this._dopamine(dtMs);   // always run: the baseline must keep tracking
    let pk = 0; for (let i = 0; i < this.danDrive.length; i++) if (this.danDrive[i] > pk) pk = this.danDrive[i];
    this.stats.phasicMax = pk;
    this.stats.phasicPeak = Math.max(this.stats.phasicPeak || 0, pk);
    if (this.learn && phasic) {
      const { kcRow, rowPtr, edgeMbon } = this.ix, dd = this.danDrive, dep = this.depress;
      const rate = this.p.eta * dtMs;
      for (let r = 0; r < kcRow.length; r++) {
        const tr = trace[kcRow[r]];
        if (tr < this.p.kcEps) continue;          // sparse coding: most rows exit here
        const gain = rate * tr;
        for (let k = rowPtr[r]; k < rowPtr[r + 1]; k++) {
          const d = dd[edgeMbon[k]];
          if (d <= 0) continue;
          const v = dep[k] + gain * d;
          dep[k] = v > 1 ? 1 : v;
          this.dirty = true;
        }
      }
    }

    // --- forgetting + bookkeeping, batched: a full sweep of ~29k edges every millisecond would
    // cost more than the rest of this file put together, and the recovery constant is minutes.
    this._sinceHouse += dtMs;
    if (this.dirty && this._sinceHouse >= 64) {
      const dec = Math.exp(-this._sinceHouse / this.p.recoverMs);
      this._sinceHouse = 0;
      const dep = this.depress;
      let n = 0, sum = 0, mx = 0, live = 0;
      for (let k = 0; k < dep.length; k++) {
        const v = dep[k] * dec;
        dep[k] = v;
        if (v > 0.01) { n++; sum += v; if (v > mx) mx = v; live = 1; }
      }
      this.stats.depressed = n; this.stats.meanDepress = dep.length ? sum / dep.length : 0;
      this.stats.maxDepress = mx;
      if (!live) this.dirty = false;              // fully forgotten: drop back to the cheap path
    }

    // Nothing learned yet means no correction to deliver, and the fly behaves exactly as an
    // unmodified build would. This is also the whole cost of the feature when learning is off.
    if (!this.dirty) return;

    // Deliver the depression as a negative conductance, proportional to how strongly each KC is
    // currently firing. gE is a summed conductance, so a negative contribution reduces excitation
    // linearly; depress <= 1 keeps the net contribution non-negative.
    const kTrace = dtMs / 30;            // trace tau, converts trace back to an approximate rate
    const dep = this.depress, addG = this.brain.addG.bind(this.brain);
    for (let r = 0; r < kcRow.length; r++) {
      const tr = trace[kcRow[r]];
      if (tr < 1e-3) continue;           // KC coding is sparse: almost every row exits here
      const s = sign[r] * tr * kTrace;
      for (let k = rowPtr[r]; k < rowPtr[r + 1]; k++) {
        const d = dep[k];
        if (d > 1e-4) addG(target[k], -d * baseW[k] * s, 0);
      }
    }
  }

  /** Summary for the UI / notes. */
  readout() {
    const d = this.depress;
    let n = 0, sum = 0;
    for (let i = 0; i < d.length; i++) { sum += d[i]; if (d[i] > 0.01) n++; }
    this.stats.depressed = n;
    this.stats.meanDepress = d.length ? sum / d.length : 0;
    return this.stats;
  }

  reset() { this.depress.fill(0); this.dirty = false; }
}

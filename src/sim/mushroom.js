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
  const danIds = []; for (let i = 0; i < N; i++) if (isDAN[i]) danIds.push(i);
  const mbonIds = []; for (let i = 0; i < N; i++) if (isMBON[i]) mbonIds.push(i);

  return {
    nKC: kcRow.length,
    nEdges: target.length,
    kcRow: sab(Uint32Array, kcRow),
    rowPtr: sab(Uint32Array, rowPtr),
    target: sab(Uint32Array, target),
    baseW: sab(Float32Array, baseW),
    sign: sab(Float32Array, kcRow.map(i => gSign[i])),
    danIds: sab(Uint32Array, danIds),
    mbonIds: sab(Uint32Array, mbonIds),
  };
}

/** Per-fly plastic state over the KC -> MBON slice. One of these per FlyAgent. */
export class MushroomBody {
  constructor(index, brain) {
    this.ix = index; this.brain = brain;
    // Depression fraction per edge, 0 = naive (full connectome weight), 1 = fully suppressed.
    this.depress = new Float32Array(index.nEdges);
    this.dirty = false;                  // set once anything is actually learned
    this.stats = { kcDrive: 0, danDrive: 0, edges: index.nEdges, depressed: 0, meanDepress: 0 };
    this._acc = 0;
  }

  /**
   * Called once per simulated millisecond, after the brain has stepped.
   * Reads the trace shadow (valid on both backends) and, once depression is non-zero, injects a
   * negative correction into each MBON so the net synapse is weaker than the shared graph says.
   */
  step(dtMs = 1) {
    const { kcRow, rowPtr, target, baseW, sign, danIds } = this.ix;
    const trace = this.brain.trace;
    if (!trace) return;

    // Instrumentation: how much the two populations are driving right now.
    let kcT = 0; for (let r = 0; r < kcRow.length; r++) kcT += trace[kcRow[r]];
    let danT = 0; for (let d = 0; d < danIds.length; d++) danT += trace[danIds[d]];
    this.stats.kcDrive = kcT; this.stats.danDrive = danT;

    // Stage 1: nothing has been learned, so there is no correction to deliver. Skipping here is
    // what makes this commit provably behaviour-neutral.
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

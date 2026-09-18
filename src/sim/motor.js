// Motor output: connectome activity -> actuator commands.
// Two modes:
//  'descending' (default): the brain's real descending neurons set locomotor drive (forward/backward) and
//     steering; a stepping pattern generator (optimised tripod gait) executes it. Proboscis, antennae and the
//     giant-fibre jump are driven directly by their motor neurons.
//  'connectome': every mapped leg muscle is driven by its own motor neurons through the VNC connectome.
export const DN_ROLES = {
  // Locomotion phenotypes of DN activation: Cande et al. 2018 (eLife 7:e34275), Bidaye et al. 2014/2020,
  // Sapkal et al. 2024 (BDN2, oDN1), Rayshubskiy et al. 2020 (DNa02 steering), von Reyn 2014 (GF).
  // walking command neurons carry the drive; the others are visually driven all the time and only modulate it
  // DNp09 REMOVED from forward drive. Full audit: docs/25-bodymap-provenance.md It was weighted 1, equal to DNg100 and DNg97, and carried
  // 26.3% of the pool's weighted mass. Its documented primary function is the opposite: silencing
  // it disrupts freezing without preventing fleeing, and optogenetic activation triggers freezing
  // in about 60% of trials (Zacarias et al., 2018). Activation does produce a transient speed
  // increase before the freeze, so DNp09 is not purely a stop command -- it is state-dependent,
  // and this model has no representation of that state. Rather than encode a context-dependent
  // neuron as a context-free forward drive, it is dropped from the walking pool. It is retained
  // in `turn` at its original weight, which is a separate claim and was not audited.
  //
  // DNg25 also removed: it matches zero neurons in this dataset and contributed nothing.
  forward: { DNg100: 1, DNg97: 1, DNa05: 0.2, DNa07: 0.2, DNp26: 0.2, DNa01: 0.1, DNa02: 0.1 },
  backward: { MDN: 1 },
  turn: { DNa02: 1.0, DNa01: 0.6, DNp09: 0.5 },   // ipsilateral steering
  groom: { DNg07: 1, DNg08: 1, DNg12: 1 },         // head grooming with the front legs
  escape: { DNp01: 1 },                            // giant fibre
  // Takeoff. DNp02/DNp04 were chosen from the looming-escape literature; DNp06 and DNp10 were
  // added after asking the connectome a different question -- WHICH descending neurons synapse
  // onto the jump muscle motor neurons (TTMn)? The answer is exactly four types: DNp01 (90
  // synapses), DNp06 (53), DNp02 (26), DNp10 (8). Two of the four were not being read at all, so
  // the jump command pathway was incomplete: a brain could recruit DNp06 and nothing downstream
  // would notice. Selection here is by MOTOR TARGET, not by what drives the neuron, so including
  // them does not presuppose which stimulus ought to trigger a jump.
  //
  // They remain the escape cluster, so this does not manufacture a thermal escape route. It makes
  // the question answerable: if noxious heat recruits the jump pathway, the body can now act on it.
  takeoff: { DNp02: 1, DNp04: 1, DNp06: 1, DNp10: 1 },
  courtP: { pIP10: 1 },                            // P1->VNC courtship interneuron (fru+; Deutsch et al. 2020)
  // DNp13 is a SONG neuron, not a pursuit neuron. It is dsx+, connects strongly to the TN1A sine
  // neurons, and increases sine song production when co-activated with pIP10 (Ding et al., 2024).
  // The earlier label "courtship pursuit descending neuron" was wrong; the courtship grouping is
  // right, so the readout is unchanged and only the claim about what it does is corrected.
  courtDN: { DNp13: 1 },
};
export const READOUT = { takeoffThreshold: 70, takeoffRatio: 3, takeoffTauSlow: 3000, takeoffInit: 20, startupMs: 1500, gfSpikes: 4, gfWindow: 50, fwdThreshold: 4, fwdScale: 12, turnScale: 25, turnAdaptTau: 4000, backMax: 0.35, groomScale: 40, turnTau: 150, flightTurnTau: 50, muscleHalf: 17,
  courtPBase: 5, courtPScale: 4, courtDNBase: 12, courtDNScale: 8 };   // courtship readout: baseline-subtracted, normalised
// fwd: walking needs weighted DN drive above threshold (Hz); speed = 1 - exp(-excess / fwdScale).
// muscles: activation = 1 - exp(-rate * ln2 / muscleHalf), i.e. half-maximal at ~17 Hz (insect force-frequency curves saturate early)
const LEGS = ['T1', 'T2', 'T3'], SIDES = ['left', 'right'];
// jump program selected by scripts/jump_test2.py: lands upright from any walking phase, >=1.1 mm hop
const JUMP = { pre: 30, push: 20, f2: 0.7, t2: 0.5, f3: 0.4, f1: 0.5, fly: 80 };   // scripts/jump_test3.py: 24/24 upright from fast turning gaits
// righting reflex (VNC-level): inverted > 150 ms -> the RAISED flank's wing and legs push on the
// substrate while the legs flail in tripod antiphase. The claim that this rights the fly from all
// tested starts within ~0.1 s came from scripts/righting_test.py and has never held in the arena:
// measured success was 1-3 in 12. See the reflex body for what was actually measured.
// `aL`/`aR` are now the PUSHING and TRAILING sides rather than left and right -- see the reflex.
export const RIGHT = { f: 6, aL: 1.0, aR: 0.3, tib: 0.5, abd: 0.5, wy: 1.0, wr: -1.0, wp: -1.0, wf: 4,
                commitAt: -0.25,   // `up` past which the reflex stops rocking and holds the push
                sideLatch: 0.15,   // |roll| needed to re-pick the pushing side once one is chosen
                mirror: 1,         // 0 pins the push to the left, i.e. the old fixed-side reflex
                                   // -- the control arm for bench/probe-righting.mjs
                // THE CONTROL ARM THAT WAS MISSING. Four attempts at this reflex compared tunings
                // against other tunings and never against NOTHING, so no run ever established that
                // the drive moves the animal at all. `off` disables the reflex entirely and leaves
                // the flip to physics, which is the baseline every one of those comparisons needed.
                off: 0,
                // COMMIT FREEZES lph AT pi/2 FOR ALL SIX LEGS, so `sin(lph) > 0` below is true for
                // every one of them and the animal grips the floor with all six claws for the whole
                // of the commit -- the exact phase in which the body has to rotate. That is the
                // suspect for why the reflex lifts past horizontal and then cannot finish.
                // 1 keeps the grip (the behaviour as measured); 0 releases it while committed.
                //
                // MEASURED 2026-09-18, 8 paired drops, side-selected vs the same with the grip
                // released (bench/righting-rig.mjs 8 side,release):
                //
                //     grip held     2/8 righted, mean max up 0.639
                //     grip released 5/8 righted, mean max up 0.741
                //     discordant pairs 3, ALL favouring release; exact McNemar p = 0.250
                //
                // The three rescues are plateau-and-fall failures completing: 0.570 -> 0.803,
                // 0.537 -> 0.801, 0.656 -> 0.811. Both arms engaged 8/8 and pushed right 5/8,
                // identically, so the grip was the only difference between them.
                //
                // CONFIRMED at the powered N. `node bench/righting-rig.mjs 16 ships,grip`,
                // 16 paired drops, identical initial conditions, grip the only difference:
                //
                //     grip released  11/16 righted, mean max up 0.755
                //     grip held       5/16 righted, mean max up 0.639
                //     discordant 6, ALL favouring release; exact McNemar p = 0.031
                //
                //     by landing flank      left flank up        right flank up
                //       grip released       8/8  max up 0.816    3/8  max up 0.694
                //       grip held           5/8  max up 0.766    0/8  max up 0.512
                //
                // Releasing the grip rights every left-flank-up drop and recovers three of the
                // right-flank-up class, which the held grip never righted at all. Both arms
                // engaged 16/16 and pushed right 8/16, identically.
                //
                // The mechanism is in the two lines above: lph is frozen at pi/2 for all six legs,
                // so `sin(lph) > 0` holds every claw down for the whole commit and the animal
                // anchors the floor with the legs it has to roll over. `commitGrip: 1` reproduces
                // the old behaviour as a control arm.
                //
                // Measured with the brain silent (see bench/righting-rig.mjs). Whether it survives
                // in the page, where descending drive is also acting, is bench/probe-righting.mjs
                // and has not been run.
                commitGrip: 0 };
const PIVOT = { turn: 0.25, amp: 0.55, inner: -0.7 };   // turning on the spot
const PHASE = { T1_left: 0, T2_right: 0, T3_left: 0, T1_right: Math.PI, T2_left: Math.PI, T3_right: Math.PI };

export class Motor {
  /**
   * @param {object} opts  { dnAll } -- when true, the WHOLE descending population contributes to
   *   locomotor drive, not only the ~18 named types. See readDescending().
   */
  constructor(mj, model, data, bodymap, typeOf, sideOf, gait, mode = 'descending', opts = {}) {
    this.model = model; this.data = data; this.mode = mode; this.gait = gait;
    this.act = {}; for (let i = 0; i < model.nu; i++) this.act[model.actuator(i).name] = i;
    this.range = {}; const cr = model.actuator_ctrlrange; for (let i = 0; i < model.nu; i++) this.range[model.actuator(i).name] = [cr[2 * i], cr[2 * i + 1]];
    const byType = (t, s) => { const o = []; for (let i = 0; i < typeOf.length; i++) if (typeOf[i] === t && (s === undefined || sideOf[i] === s)) o.push(i); return o; };
    const pop = (roles, s) => Object.entries(roles).flatMap(([t, w]) => byType(t, s).map(i => [i, w]));
    this.dn = { forward: pop(DN_ROLES.forward), backward: pop(DN_ROLES.backward), escape: pop(DN_ROLES.escape).map(x => x[0]), takeoff: pop(DN_ROLES.takeoff), groom: pop(DN_ROLES.groom),
      turnL: pop(DN_ROLES.turn, 1), turnR: pop(DN_ROLES.turn, 2), courtP: pop(DN_ROLES.courtP), courtDN: pop(DN_ROLES.courtDN) };
    // The FULL descending population, by superclass rather than by name. The motor layer proper
    // reads ~18 named types; this is every neuron the connectome labels descending, so the
    // population can be MEASURED even when it is not read. Without it, a fly that fails to escape
    // cannot be told apart from a fly whose escape command is computed and then ignored.
    // NOTE: `data` here is the MuJoCo data object, not the connectome. The superclass array and
    // its names come through opts. An earlier version read data.meta.superclasses, found
    // undefined, and silently selected ZERO descending neurons -- the instrumentation reported
    // "all 0 neurons" and the experiment it was built for produced no answer.
    const scNames = opts.superclassNames || [];
    const scArr = opts.superclass;
    const dnSc = scNames.indexOf('descending_neuron');
    this.dnAllIdx = []; this.dnAllSide = [];
    if (dnSc >= 0 && scArr) {
      for (let i = 0; i < scArr.length; i++) {
        if (scArr[i] === dnSc) { this.dnAllIdx.push(i); this.dnAllSide.push(sideOf[i]); }
      }
    }
    if (!this.dnAllIdx.length) console.warn('[motor] descending population is EMPTY — instrumentation inactive');
    this.dnAllIdx = Int32Array.from(this.dnAllIdx);
    this.dnAllSide = Int8Array.from(this.dnAllSide);
    this.useAllDN = !!opts.dnAll;
    this.dnStats = { pop: 0, left: 0, right: 0, n: this.dnAllIdx.length, base: 0, rel: 0 };
    this._dnBase = 0; this._dnPrimed = false;

    this.muscles = bodymap.muscles; this.ttmn = bodymap.jump;
    this.rate = new Float32Array(typeOf.length);    // low-pass filtered firing rate per neuron (Hz), only for used neurons
    this.used = new Set([...this.dn.forward.map(x => x[0]), ...this.dn.backward.map(x => x[0]), ...this.dn.escape, ...this.dn.takeoff.map(x => x[0]), ...this.dn.groom.map(x => x[0]), ...this.dn.turnL.map(x => x[0]), ...this.dn.turnR.map(x => x[0]), ...this.dn.courtP.map(x => x[0]), ...this.dn.courtDN.map(x => x[0]), ...bodymap.jump, ...bodymap.feeding, ...this.dnAllIdx]);
    for (const m of this.muscles) for (const i of m.idx) this.used.add(i);
    this.used = Int32Array.from(this.used);
    this.lastCount = new Uint32Array(typeOf.length);
    this.phase = 0; this.cmd = { v: 0, turn: 0, drive: 0, back: 0, escape: 0 }; this.jumpT = -1;
    this.feedingIdx = bodymap.feeding;
  }
  /** update filtered rates from brain spike counts; dtMs since last call */
  readBrain(spikeCount, dtMs, tau = 40) {
    const k = dtMs / tau, inv = 1000 / dtMs;
    this.gfTimes = this.gfTimes || []; for (const i of this.dn.escape) if (spikeCount[i] !== this.lastCount[i]) this.gfTimes.push(this.tNow || 0);
    for (const i of this.used) { const n = spikeCount[i] - this.lastCount[i]; this.lastCount[i] = spikeCount[i]; this.rate[i] += k * (n * inv - this.rate[i]); }
  }
  mean(ix) { let s = 0; for (const i of ix) s += this.rate[i]; return ix.length ? s / ix.length : 0; }
  wmean(pairs) { let s = 0, w = 0; for (const [i, wt] of pairs) { s += this.rate[i] * wt; w += wt; } return w ? s / w : 0; }
  /** compute and write actuator controls */
  apply(tMs, dtMs, extra = {}) {
    const d = this.data, ctrl = d.ctrl, A = this.act, R = this.range;
    const set = (name, v) => { const i = A[name]; if (i === undefined) return; const [lo, hi] = R[name]; ctrl[i] = Math.min(hi, Math.max(lo, v)); };
    // --- muscles driven directly by motor neurons (activation = rate / 100 Hz, saturating) ---
    const actv = {};
    const kHalf = Math.LN2 / READOUT.muscleHalf;
    for (const m of this.muscles) { const a = 1 - Math.exp(-this.mean(m.idx) * kHalf); (actv[m.actuator] ||= []).push([m.dir, a]); }
    // NET first, then scale. The previous form summed each muscle's contribution scaled by the
    // distance to its own end of the range, which gives agonist and antagonist unequal authority
    // whenever the joint range is asymmetric about `rest`. femur_T1_left runs [-0.15, 2.0], so an
    // extensor firing at activation a contributed a*2.0 while a flexor at the same a contributed
    // only -a*0.15: balanced motor-neuron activity produced a net of +1.85 and pinned the joint at
    // its limit. Measured in connectome mode: 4 of 48 leg joints sat at a range limit and the
    // animal could not hold a posture, which was reported as the connectome being unable to stand.
    // It was the read-out. Computing the net activation first means equal drive on both sides
    // returns exactly `rest`, and the full range stays reachable when drive is one-sided.
    // MEAN PER DIRECTION, not sum. Each muscle's activation is already bounded in [0,1), but the
    // count of muscles mapped to one actuator is not: summing three extensors at a modest 0.6 each
    // gives 1.8, and any net beyond 1 pins the joint at a range limit no matter how the ranges are
    // scaled. That is a second, independent saturation from the asymmetric-range one fixed above,
    // and it survived it -- runs on 2026-09-16 still showed 6 and 8 of 48 joints pinned, with the
    // animal toppling into a righting response partway through locomotion. Averaging makes each
    // direction contribute at most 1 regardless of how many muscles the connectome assigns to it,
    // so net lies in [-1, 1] and a joint reaches its limit only under sustained one-sided drive
    // (~73 Hz with the antagonist silent, given muscleHalf = 17). Joint count stops being a gain.
    const muscleCtrl = (name, rest = 0) => {
      const [lo, hi] = R[name];
      let ext = 0, nExt = 0, flex = 0, nFlex = 0;
      for (const [dir, a] of actv[name] || []) { if (dir > 0) { ext += a; nExt++; } else { flex += a; nFlex++; } }
      const net = (nExt ? ext / nExt : 0) - (nFlex ? flex / nFlex : 0);
      return rest + (net >= 0 ? net * (hi - rest) : net * (rest - lo));
    };
    for (const name of ['rostrum', 'haustellum', 'labrum_left', 'labrum_right', 'antenna_left', 'antenna_right']) if (A[name] !== undefined) set(name, muscleCtrl(name));
    // --- locomotion ---
    const fwd = this.wmean(this.dn.forward), back = this.wmean(this.dn.backward), groom = this.wmean(this.dn.groom);
    const turn = this.wmean(this.dn.turnL) - this.wmean(this.dn.turnR);
    const R0 = READOUT;
    const grooming = groom / R0.groomScale > 0.5 && groom > 1.5 * fwd;
    const net = fwd - 2 * back;
    // backward walking (MDN) is slow in real flies, ~1 cm/s, a third of top forward speed
    const sat = x => 1 - Math.exp(-x / R0.fwdScale);   // speed saturates smoothly with DN drive
    const v = grooming ? 0 : (net > R0.fwdThreshold ? sat(net - R0.fwdThreshold) : back > R0.fwdThreshold ? -R0.backMax * sat(back - R0.fwdThreshold) : 0);
    this.turnF = (this.turnF || 0) + dtMs / (this.flying ? R0.flightTurnTau : R0.turnTau) * (turn - (this.turnF || 0));   // flight steering is faster
    // slow adaptation removes standing left/right imbalances of the steering DNs (the model's DNa02 and P9
    // pairs receive unequal tonic input), keeping transient asymmetries: saccades, plumes, objects
    this.turnBase = (this.turnBase || 0) + dtMs / R0.turnAdaptTau * (this.turnF - (this.turnBase || 0));
    // courtship circuit readout: pIP10 and DNp13 sit downstream of the pheromone pathways (2 hops from the
    // cVA and tarsal pheromone receptors); both roughly double their rate near another fly
    // --- the descending population as a whole -------------------------------------------------
    // Measured every step whether or not it is read, so "did the brain issue a command" is a
    // question with an answer rather than an inference.
    {
      const ix = this.dnAllIdx, sd = this.dnAllSide;
      let sum = 0, l = 0, nl = 0, r = 0, nr = 0;
      for (let k = 0; k < ix.length; k++) {
        const v = this.rate[ix[k]];
        sum += v;
        if (sd[k] === 1) { l += v; nl++; } else if (sd[k] === 2) { r += v; nr++; }
      }
      const pop = ix.length ? sum / ix.length : 0;
      // slow baseline, so a RISE is detectable against this population's own tonic level
      if (!this._dnPrimed) { this._dnBase = pop; this._dnPrimed = true; }
      else this._dnBase += (pop - this._dnBase) * 0.0002;        // ~5 s at 1 ms steps
      this.dnStats = { pop, left: nl ? l / nl : 0, right: nr ? r / nr : 0, n: ix.length,
        base: this._dnBase, rel: this._dnBase > 1e-6 ? (pop - this._dnBase) / this._dnBase : 0 };
    }

    const court = Math.max(0, Math.min(1, 0.5 * Math.max(0, this.wmean(this.dn.courtP) - R0.courtPBase) / R0.courtPScale + 0.5 * Math.max(0, this.wmean(this.dn.courtDN) - R0.courtDNBase) / R0.courtDNScale));
    // ?dnall=1: let the whole population contribute. Total rise above the population's own tonic
    // level adds forward drive; the left/right imbalance adds steering. This is a population-vector
    // assumption and a strong one -- descending neurons are heterogeneous, and some of them command
    // stopping, grooming or backward walking, so summing them measures "how loudly is the brain
    // saying something" rather than "what is it saying". It is a test of whether the signal exists
    // in the population at all, not a claim about the decoding the ventral nerve cord performs.
    let vAll = v, turnAll = null;
    if (this.useAllDN && this.dnAllIdx.length) {
      const d = this.dnStats;
      const push = Math.max(0, d.rel) * 1.2;                     // relative rise -> extra drive
      vAll = Math.min(1, v + push);
      const imbalance = (d.left - d.right) / Math.max(1e-6, d.left + d.right);
      turnAll = Math.max(-0.6, Math.min(0.6, imbalance * 2.5));
    }
    this.cmd = { v: vAll, turn: turnAll !== null ? turnAll : Math.max(-0.6, Math.min(0.6, (this.turnF - this.turnBase) / R0.turnScale)), drive: fwd, back, groom, grooming, escape: this.mean(this.dn.escape), takeoff: this.wmean(this.dn.takeoff), court, dn: this.dnStats };
    if (this.mode === 'connectome') {
      for (const leg of LEGS) for (const sd of SIDES) {
        for (const j of ['coxa', 'coxa_abduct', 'coxa_twist', 'femur', 'femur_twist', 'tibia', 'tarsus', 'tarsus2']) set(`${j}_${leg}_${sd}`, muscleCtrl(`${j}_${leg}_${sd}`));
        set(`adhere_claw_${leg}_${sd}`, 0.6 + 0.4 * Math.min(1, (actv[`adhere_claw_${leg}_${sd}`] || []).reduce((a, [, x]) => a + x, 0)));
      }
    } else {
      // a standing fly with a strong steering command turns on the spot: the inner legs step backwards
      const pivot = Math.abs(v) < 0.1 && Math.abs(this.cmd.turn) > PIVOT.turn;
      const g = this.gait, amp = pivot ? PIVOT.amp : Math.min(1, Math.abs(v) * 1.5), freq = g.freq * (0.5 + 0.5 * Math.min(1, pivot ? PIVOT.amp : Math.abs(v)));
      this.stepAmp = amp > 0.05 ? Math.min(1, amp * 2) : 0; this.pivot = pivot;
      if (amp > 0.05) this.phase += (pivot ? 1 : Math.sign(v)) * 2 * Math.PI * freq * dtMs / 1000;
      for (const leg of LEGS) for (const sd of SIDES) {
        const key = `${leg}_${sd}`, phi = this.phase + PHASE[key];
        const inner = (this.cmd.turn > 0) === (sd === 'left');
        const steer = pivot ? (inner ? PIVOT.inner : 1) : 1 + this.cmd.turn * (sd === 'left' ? -1 : 1);   // turn>0 (left DNs) -> shorter left strides -> turn left
        for (const j of g.joints) {
          const [off, a1, p1, a2, p2] = g.params[leg][j];
          let q = a1 * Math.cos(phi + p1) + a2 * Math.cos(2 * phi + p2);
          if (j === 'coxa') q *= steer;
          set(`${j}_${key}`, amp * (off + q));
        }
        const stance = ((phi + g.adhPhase) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) < 2 * Math.PI * g.duty;
        set(`adhere_claw_${key}`, amp > 0.05 ? (stance ? 1 : 0) : 0.8);
      }
    }
    // --- courtship song: one wing (on the side facing the other fly) extended and vibrating ---
    if (extra.court?.sing && !this.jumping && !this.flying && !this.righting) {
      const sd = extra.court.side === 'right' ? 'right' : 'left';
      const w = 0.5 + 0.5 * Math.sin(2 * Math.PI * 30 * tMs / 1000);   // song pulses rendered as a visible flutter
      set(`wing_yaw_${sd}`, 1.35); set(`wing_roll_${sd}`, 0.5); set(`wing_pitch_${sd}`, -0.5 - 0.4 * w);
      this.cmd.singing = true;
    }
    // --- head grooming (DNg07/08/12): front legs lift and sweep over the head/eyes in antiphase (~7 Hz) ---
    if (this.cmd.grooming && this.mode !== 'connectome') {
      this.groomPhase = (this.groomPhase || 0) + 2 * Math.PI * 7 * dtMs / 1000;
      for (const sd of SIDES) { const ph = this.groomPhase + (sd === 'left' ? 0 : Math.PI);
        set(`coxa_T1_${sd}`, 1.1 + 0.25 * Math.sin(ph)); set(`femur_T1_${sd}`, -0.1); set(`tibia_T1_${sd}`, -0.9 + 0.35 * Math.sin(ph + 0.8));
        set(`coxa_twist_T1_${sd}`, 0.3 * Math.sin(ph)); set(`tarsus_T1_${sd}`, 0.4); set(`adhere_claw_T1_${sd}`, 0); }
    }
    // --- giant fibre escape: GF spikes -> TTM (electrical synapse) -> middle legs extend explosively ---
    const gf = this.cmd.escape, ttm = this.mean(this.ttmn);
    // escape: a single GF spike drives TTMn 1:1 (electrical synapse) -> jump; or the looming-sensitive takeoff DNs
    // rise sharply above their own recent baseline (a loom, not the fluctuations of self-motion)
    this.tNow = tMs; this.gfTimes = (this.gfTimes || []).filter(t => tMs - t < READOUT.gfWindow); this.gfSpike = this.gfTimes.length >= READOUT.gfSpikes;
    const to = this.cmd.takeoff; this.toSlow = this.toSlow === undefined ? READOUT.takeoffInit : this.toSlow + dtMs / READOUT.takeoffTauSlow * (to - this.toSlow);
    const loomTakeoff = to > READOUT.takeoffThreshold && to > READOUT.takeoffRatio * this.toSlow;
    // an inverted fly cannot jump; nor does one whose antennae are on the object filling its view (a wall it
    // walked into looms on the eye, but touch says it is not an approaching predator)
    // `urgent` (a burning tarsus, from the escape reflex in intrinsic.js) overrides the contact
    // gate but NOT the posture gates: an inverted, righting or already-flying animal still cannot
    // launch, because it physically cannot. Only the "pressed against something" veto is lifted.
    const canJump = (extra.up ?? 1) > 0.5 && !this.righting && !(this.recoverUntil > tMs) && !this.flying
      && (!extra.touching || (extra.voluntary && !extra.contact) || extra.urgent);
    // WHY A TAKEOFF WAS REFUSED. A request that is issued and vetoed is indistinguishable from one
    // that was never issued, from outside: both look like a fly that stays on the ground. Check 3
    // of the verification harness failed while the strictly harder check 4b passed, which no
    // amount of reasoning about the gate could settle without knowing which term was false.
    if (extra.voluntary || this.gfSpike || loomTakeoff) {
      this.jumpVeto = !((extra.up ?? 1) > 0.5) ? 'inverted'
        : this.righting ? 'righting'
        : this.recoverUntil > tMs ? 'recovering'
        : this.flying ? 'already flying'
        : (extra.touching && !(extra.voluntary && !extra.contact) && !extra.urgent) ? 'contact gate'
        : this.jumpT >= 0 ? 'jump in progress'
        : tMs <= READOUT.startupMs ? 'startup lockout'
        : null;
      if (this.jumpVeto) this.jumpVetoT = tMs;
    }
    if ((this.gfSpike || loomTakeoff || extra.voluntary) && canJump && this.jumpT < 0 && tMs > READOUT.startupMs) { this.jumpT = tMs; this.launchT = -1; this.jumpCause = this.gfSpike ? 'GF burst' : loomTakeoff ? `takeoff DNs ${to.toFixed(0)}Hz (baseline ${this.toSlow.toFixed(0)})` : 'voluntary'; if (globalThis.LOG_JUMPS) console.log(`jump at ${tMs} ms: ${this.jumpCause}, up ${(extra.up ?? 1).toFixed(2)}`); }
    if (this.jumpT >= 0) {
      // jump program (tested in scripts/jump_test.py): TTM drives both middle legs to full extension for 20 ms,
      // hind femora half-extended, all tarsi released; ~2.5 mm hop that lands upright
      const J = JUMP, dtj = tMs - this.jumpT - J.pre;   // 30 ms symmetric pre-jump posture (long-mode takeoff), then TTM push
      const all = ['coxa', 'coxa_abduct', 'coxa_twist', 'femur', 'femur_twist', 'tibia', 'tarsus', 'tarsus2'];
      this.jumping = dtj < J.push + J.fly + 190;
      if (this.jumping) for (const leg of LEGS) for (const sd of SIDES) {
        for (const j of all) set(`${j}_${leg}_${sd}`, 0);                      // symmetric posture
        if (dtj >= J.push && this.launchT < 0) this.launchT = tMs;              // push done: airborne, the wings take over
        if (dtj >= 0 && dtj < J.push) {                                         // TTM push
          if (leg === 'T2') { set(`femur_T2_${sd}`, J.f2 * R[`femur_T2_${sd}`][1]); set(`tibia_T2_${sd}`, J.t2 * R[`tibia_T2_${sd}`][1]); }
          if (leg === 'T3') set(`femur_T3_${sd}`, J.f3 * R[`femur_T3_${sd}`][1]);
          if (leg === 'T1') set(`femur_T1_${sd}`, J.f1 * R[`femur_T1_${sd}`][1]);
        }
        set(`adhere_claw_${leg}_${sd}`, dtj < 0 ? 0.8 : dtj < J.push + J.fly ? 0 : 0.8);
      }
      if (dtj > 1000) { this.jumpT = -1; this.jumping = false; }   // refractory period
    }
    // --- righting reflex ---
    const up = extra.up ?? 1;
    this.invertedMs = up < -0.3 && !this.flying ? (this.invertedMs || 0) + dtMs : 0;
    if (!RIGHT.off && (this.invertedMs > 150 || (this.righting && up < 0.8))) {
      this.righting = true; const t = tMs / 1000, P = RIGHT;
      // PUSH WITH THE FLANK THAT IS RAISED, not with the left.
      //
      // Measured with bench/probe-rollside.mjs, 12 flips: the animal settles onto EITHER side, 5
      // right and 6 left, near enough a coin flip. Split by side, with the old left-only drive:
      //
      //     lying on the RIGHT (left flank up)   3 of 5 got past horizontal, 1 righted
      //     lying on the left  (right flank up)  0 of 6 got past horizontal, 0 righted
      //
      // That reading suggested the left-strong drive simply had no working mode for the other half
      // of trials, and that pushing with the raised side would rescue them.
      //
      // IT DOES NOT. Measured 2026-09-18 with bench/righting-rig.mjs, 10 drops run twice from
      // IDENTICAL initial conditions, once with this selection and once pinned left:
      //
      //     side-selected 3/10      fixed-left 3/10      NO DISCORDANT PAIRS
      //     side-selected pushed RIGHT on 6 of 10, fixed-left on 0 of 10
      //
      // The selection engages, picks a different side from the control on six of ten drops, and
      // changes nothing: the three successes were bit-identical in both arms. The failures all
      // reach `up` of about 0.51 to 0.61 -- past horizontal -- and fall back, whichever side
      // pushes.
      //
      // THE REFLEX ITSELF WORKS. RIGHT.off, the control no previous attempt ever ran, was measured
      // on the same six drops:
      //
      //     reflex off   max up -0.676 to -0.684 on 6 of 6 -- it never leaves its back
      //     reflex on    max up  0.425 to  0.836, and every success in the whole run
      //
      // So the drive is worth about 1.2 in `up` on every single drop and is responsible for all
      // the righting there is. It is neither dead nor too weak, which is what three of the four
      // previous attempts assumed when they raised gains. What it does not do is FINISH: it lifts
      // the animal past horizontal and then cannot carry it through the last third of the roll,
      // and that failure is indifferent to which side pushes.
      //
      // The selection is LEFT IN PLACE rather than reverted. It costs nothing measurable, and
      // removing it on 10 drops whose rolls all clustered near +/-0.70 would be as unevidenced as
      // adopting it was.
      //
      // roll is xmat[7], the world-z component of the body's y axis, and local +y is the animal's
      // LEFT. roll > 0 therefore means the left flank is raised, and the left is the side to push
      // with -- which is what the old constants did, for that half of the cases only.
      //
      // LATCHED, because roll crosses zero constantly while the animal rocks: re-picking the side
      // every step would swap the drive mid-stroke and cancel the momentum the oscillation exists
      // to build. The side is chosen when the reflex starts and only changes if the animal has
      // clearly gone over onto the other flank.
      const roll = extra.roll ?? 0;
      if (!this.pushSide || Math.abs(roll) > P.sideLatch)
        this.pushSide = P.mirror === 0 ? 'left' : (roll > 0 ? 'left' : 'right');
      const pushing = this.pushSide, trailing = pushing === 'left' ? 'right' : 'left';
      // COMMIT ONCE THE ROLL IS WON, instead of rocking forever.
      //
      // Measured with bench/probe-righting.mjs on a deliberately flipped animal on a cool floor:
      // `up` ran -0.88 -> +0.33 -> -0.56 over 12 s, 714 of 722 samples labelled righting, all 18 leg
      // joints receiving commands. So the motion was not dead and not too weak -- it got the animal
      // a third of the way past horizontal and then let it fall back, over and over. The cause is
      // that the drive is a 6 Hz oscillation: half of every cycle pushes the animal over, and the
      // other half pushes it back. That is fine for building momentum from supine and exactly wrong
      // once it is on edge, which is the point where a real fly plants its legs and follows through.
      //
      // So above `commitAt` the phase is FROZEN at the top of the push (sin = 1) rather than allowed
      // to reverse, and the wing holds instead of beating. The oscillation still does the work of
      // getting off the back; the hold does the work of finishing.
      const committed = up > P.commitAt;
      const lphBase = 2 * Math.PI * P.f * t;
      for (const leg of LEGS) for (const sd of SIDES) {
        const amp = sd === pushing ? P.aL : P.aR;
        const phase = lphBase + (['T1_left', 'T2_right', 'T3_left'].includes(`${leg}_${sd}`) ? 0 : Math.PI);
        const lph = committed ? Math.PI / 2 : phase;      // frozen at full push once committed
        set(`coxa_${leg}_${sd}`, amp * Math.sin(lph) * R[`coxa_${leg}_${sd}`][1]);
        set(`femur_${leg}_${sd}`, amp * (0.5 + 0.5 * Math.sin(lph)) * R[`femur_${leg}_${sd}`][1]);
        set(`tibia_${leg}_${sd}`, P.tib * R[`tibia_${leg}_${sd}`][1]);
        set(`coxa_abduct_${leg}_${sd}`, R[`coxa_abduct_${leg}_${sd}`][0] * P.abd * (sd === pushing ? 1 : 0.2));
        // Claws grip on the push half only. While committed the pushing legs hold their grip, which
        // is what lets the animal lever itself over rather than skating.
        set(`adhere_claw_${leg}_${sd}`, committed && !P.commitGrip ? 0 : (Math.sin(lph) > 0 ? 1 : 0));
      }
      const w = committed ? 1 : 0.5 + 0.5 * Math.sin(2 * Math.PI * P.wf * t);
      // The wing beats on the pushing side too, and the trailing one is actively zeroed: leaving the
      // old side driven while the other takes over would have both wings beating against each other.
      set(`wing_yaw_${pushing}`, P.wy * w);
      set(`wing_roll_${pushing}`, P.wr * w);
      set(`wing_pitch_${pushing}`, P.wp * w);
      for (const ax of ['yaw', 'roll', 'pitch']) set(`wing_${ax}_${trailing}`, 0);
      this.cmd.righting = true;
    } else if (this.righting) {
      // Clear BOTH wings and drop the latch, so the next flip picks its side afresh. Zeroing only
      // the left left a driven right wing running after the reflex ended.
      this.righting = false; this.recoverUntil = tMs + 300; this.pushSide = null;
      for (const ax of ['yaw', 'roll', 'pitch']) for (const sd of SIDES) set(`wing_${ax}_${sd}`, 0);
    }
    if (!this.righting && this.recoverUntil > tMs) for (const leg of LEGS) for (const sd of SIDES) {   // settle in a standing posture after righting
      for (const j of ['coxa', 'coxa_abduct', 'coxa_twist', 'femur', 'femur_twist', 'tibia', 'tarsus', 'tarsus2']) set(`${j}_${leg}_${sd}`, 0);
      set(`adhere_claw_${leg}_${sd}`, 0.8); }
    return this.cmd;
  }
  feeding() { return 1 - Math.exp(-this.mean(this.feedingIdx) * Math.LN2 / READOUT.muscleHalf); }
  proboscisOut() { const r = this.data.ctrl[this.act.rostrum]; return r < -0.4; }
}

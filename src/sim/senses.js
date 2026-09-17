// Sensory transduction: physical state of the body and world -> firing rates of identified sensory neurons.
// Every channel drives real connectome neurons (bodymap.json); transduction curves are simple, documented
// physiology approximations (saturating concentration responses, contrast-adapting photoreceptors).
export const ODORANTS = {
  // odor -> activated glomeruli (receptor neurons) with relative sensitivity
  vinegar: { DM1: 1.0, DM4: 0.8, VA2: 0.7, DP1m: 0.9, DM2: 0.5, VM2: 0.4, DL1: 0.3 },   // Or42b, Or59b, Or92a, Ir64a...
  banana: { DM1: 0.8, DM3: 0.7, VM2: 0.6, DM2: 0.5, VA2: 0.4 },
  co2: { V: 1.0 },                                                                      // Gr21a/Gr63a, aversive
  geosmin: { DA2: 1.0 },                                                                // Or56a, aversive
  pheromone: { DA1: 1.0, VA1v: 0.7, VA1d: 0.5 },                                        // cVA (Or67d), fly odours
};
export const ORN_SPONTANEOUS = 6;   // Hz, ORN baseline firing
export const REAFFERENCE = 0.85;    // fraction of footfall touch signal cancelled while stepping
export const AL_NORM = 600;         // GABA_B presynaptic gain control: total evoked ORN drive per antenna (Hz)
                                    // divisively normalises every ORN's output (Olsen & Wilson 2008, Curr Opin
                                    // Neurobiol 18:83). The glomerular pattern is preserved; the total is bounded,
                                    // so one strong odour cannot recruit the whole lobe.
export const FLY_ODOR = { strength: 0.9, sigma: 0.28 };   // another fly is a short-range cVA/fly-odour source
// Courtship song as heard by Johnston's organ. Drosophila pulse song: ~35 ms inter-pulse
// interval, pulses a few ms long, carrier ~250 Hz. Near-field particle velocity, so the
// effective range is millimetres -- rangeCm 0.6 is ~6 mm, about two body lengths.
// `wB`/`wA`/`wC` weight the Johnston's-organ subtypes. They are not interchangeable: JO-B is the
// song-frequency channel, JO-A shares the vibration range with different tuning, and JO-C reports
// *static* antennal deflection -- wind and gravity -- so exciting it with a song would manufacture
// a response in cells that should be saying the air is still. The earlier version drove the whole
// `JO auditory` group uniformly, JO-C included.
export const SONG = { ipiMs: 35, pulseMs: 10, rangeCm: 0.6, refCm: 0.12, maxHz: 170,
                      wB: 1.0, wA: 0.55, wC: 0.0 };

export class Senses {
  constructor(bodymap, mj, model) {
    this.bm = bodymap; this.mj = mj; this.model = model;
    const S = {}; for (const s of bodymap.sensors) S[s.name] = s.idx; this.S = S;
    const T = (re) => bodymap.sensors.filter(s => re.test(s.name));
    // taste channels by tastant (Cell 2026 gustatory connectome identities)
    this.tasteTypes = {
      labellum: { sugar: ['LB3b', 'LB3c'], bitter: ['LB1a', 'LB1b', 'LB1c', 'LB1d'], water: ['LB3a'], salt: ['LB3d'] },
      leg: { sugar: ['LgLG3', 'LgLG4', 'LgAG2'], bitter: ['LgAG1'], pheromone: ['LgLG1a', 'LgLG1b', 'LgLG2', 'LgLG5', 'LgLG6', 'LgLG7', 'LgLG8'] },
      peg: { sugar: ['dorsal_tpGRN'], fatty: ['claw_tpGRN'] },
    };
    this.rates = new Map();   // neuron index -> rate (Hz) for this step
    // tactile bristles are rapidly adapting: burst at contact onset/offset (tau ~15 ms); only tarsal bristles
    // (a fixed ~25% subset of each leg's tactile neurons) touch the substrate
    this.tarsal = {}; this.touchPrev = {}; this.touchBurst = {};
    this.legBristle = {};   // the other ~75%: femur/tibia bristles, touched when a leg meets an obstacle
    for (const s of bodymap.sensors) if (s.kind === 'contact') { const key = s.name.replace('tactile ', '').replace(' ', '_'); this.tarsal[key] = s.idx.filter((_, k) => k % 4 === 0); this.legBristle[key] = s.idx.filter((_, k) => k % 4 !== 0); this.touchPrev[key] = 0; this.touchBurst[key] = 0; }
    this.photo = null;
    this.songPhase = 0;   // pulse-train phase for courtship song (see SONG)
  }
  /** called once the brain metadata is available: map taste types to neuron indices per location */
  /**
   * Nociceptive afferents onto the PPL1 dopaminergic cluster.
   *
   * WHY THIS IS ADDED RATHER THAN DERIVED. The graph has 25 thermosensory neurons -- the arista
   * cells, which report preferred temperature (Gallio et al. 2011). They are not nociceptors.
   * Noxious heat and mechanical nociception in Drosophila are carried by class IV multidendritic
   * neurons, which are peripheral and therefore almost entirely outside a central-brain EM
   * volume. The afferents that would carry "this hurts" to PPL1 are missing from the dataset,
   * not weakly connected in it.
   *
   * Measured consequence: a hot floor raises the summed PPL trace by ~11% (27.1 -> 30.2 global,
   * 11.09 -> 12.24 PPL), where the phasic gate needs ~68%. The 25 arista cells, already driven at
   * 100 Hz, reach PPL only over 103 two-hop paths through 46 intermediates -- a real route, but
   * far too thin to move a population the rule can detect.
   *
   * TARGET SUPPORTED BY THE LITERATURE, NOT ONLY BY ARGUMENT. Electric shock, heat and bitter taste
   * all converge on the same PPL1 neurons -- MP1, also called PPL1-gamma1pedc (Aso et al. 2014;
   * Felsenberg et al. 2016). The two stimuli this channel carries are exactly noxious heat and
   * bitter, so PPL1 is where they are documented to arrive, and the choice of target is better
   * founded than the surrounding text originally claimed.
   *
   * This supplies the missing afferent, in the same spirit as the giant-fibre -> TTMn electrical
   * synapse that world/motor already add explicitly because a chemical connectome cannot contain
   * it. It is a sensory channel, not a circuit being puppeted: noxious intensity in, firing rate
   * onto the neurons those afferents are known to target, and the network does the rest.
   *
   * It is OFF by default. It is an addition beyond the connectome and every result that depends
   * on it has to say so.
   *
   * TWO BRANCHES, AND THE SECOND ONE WAS MISSING. Nociception in an insect is not one pathway.
   * There is a *valence* branch -- "that hurt, learn from it" -- which is what PPL1 carries, and a
   * *reflex* branch -- "that hurt, move" -- which enters the ventral nerve cord alongside the other
   * leg and body-wall afferents and reaches motor neurons without consulting the brain. Only the
   * first was wired here. The thermal-escape experiment of 2026-09-15 consequently measured the
   * learning branch and reported a null about the escape branch: the descending population moved
   * by +0.07 Hz, 95% CI [-2.36, +2.50], because nothing downstream had been given an input.
   *
   * WHY `unknown_sensory` IN THE VNC IS THE TARGET. The dataset classifies VNC afferents as
   * gustatory, chemosensory, mechanosensory_tactile or mechanosensory_proprioceptive, and there is
   * no `nociceptive` class anywhere in its vocabulary -- the same absence, one level down, that
   * made the PPL1 injection necessary in the first place. What it does have is 1,564 vnc_sensory
   * neurons whose modality it declines to assign. A class IV multidendritic terminal, reconstructed
   * but unrecognised, lands in exactly that class. Three properties make it the defensible choice:
   *
   *   - it is the only unassigned VNC afferent class, so the choice is not among several;
   *   - all 1,564 are driven by nothing at all -- no overlap with bodymap.sensors -- so this adds
   *     a modality rather than competing with one already modelled;
   *   - 297 of them synapse directly onto vnc_motor neurons (42% of the 708-cell motor pool), and
   *     696 of 708 are within two hops. The reflex arc is present in the graph.
   *
   * WHAT IS WRONG WITH IT. This class certainly also contains afferents that are not nociceptive.
   * Driving all of it treats "unclassified" as "noxious", which is false, and makes this a coarse
   * instrument: it can show that a nociceptive drive entering the VNC produces escape, and it
   * cannot show that *the* nociceptors do. The population was NOT selected for reaching motor
   * neurons -- that was measured afterwards, and selecting on it would have been choosing the
   * answer. Like the PPL1 branch, this is an addition beyond the connectome and every result that
   * depends on it has to say so.
   *
   * @returns {{ppl:number, vnc:number}} population sizes, for the caller to report
   */
  bindNociceptors(typeOf, clsOf, scOf, meta) {
    this.ppl = [];
    for (let i = 0; i < typeOf.length; i++) if ((typeOf[i] || '').startsWith('PPL')) this.ppl.push(i);
    // reflex branch: VNC afferents of unassigned modality
    this.nociVnc = [];
    const scNames = meta?.superclasses || [], clsNames = meta?.classes || [];
    const scVnc = scNames.indexOf('vnc_sensory'), clUnk = clsNames.indexOf('unknown_sensory');
    if (scVnc >= 0 && clUnk >= 0 && scOf && clsOf) {
      for (let i = 0; i < scOf.length; i++) if (scOf[i] === scVnc && clsOf[i] === clUnk) this.nociVnc.push(i);
    }
    return { ppl: this.ppl.length, vnc: this.nociVnc.length };
  }

  /**
   * Correct the VP1m / VP1l assignments before anything reads them.
   *
   * `bodymap.json` places TRN_VP1m in the thermosensory group and HRN_VP1l in the hygrosensory
   * group. The published characterisation has them the other way round, and the evidence is
   * receptor expression rather than opinion:
   *
   *   VP1m expresses Ir68a, the receptor that defines VP5 as the humid-air glomerulus.
   *        Marin et al. (2020): "VP1m might represent humidity, with confirmation awaiting
   *        future physiological and behavioral experiments."
   *   VP1l expresses Ir21a, the receptor that defines VP3 as the cooling glomerulus.
   *        Marin et al.: "Ir21a ... was expressed in VP1l RNs, suggesting that they may be
   *        cooling responsive."
   *
   * The consequence of leaving it was not cosmetic. VP1m is 11 of the 25 neurons in the
   * thermosensory channel, so 44% of the thermal input used in five thermal-escape experiments
   * was a humidity channel being driven by heat, while the 8 genuinely cooling-responsive cells
   * were being driven by humidity.
   *
   * WHY THIS LIVES IN CODE AND NOT IN THE DATA FILE. bodymap.json is generated, carries no
   * provenance of any kind, and would silently revert on regeneration. Remapping at bind time
   * survives that, and keeps the disagreement between the code and its own data file visible
   * rather than buried in a JSON blob.
   *
   * THE AUTHORS HEDGE AND SO DO WE. Marin et al. describe these as "provisional identifications
   * based on receptor expression patterns rather than confirmed functional characterizations".
   * This remap is better supported than the assignment it replaces; neither is settled.
   */
  // Full audit of every bodymap group: docs/25-bodymap-provenance.md
  fixVPAssignments(typeOf) {
    const moved = { toThermo: 0, toHygro: 0 };
    for (const sd of ['left', 'right']) {
      const th = this.S[`thermosensory ${sd}`], hy = this.S[`hygrosensory ${sd}`];
      if (!th || !hy) continue;
      const isVP1m = i => /VP1m/.test(typeOf[i] || ''), isVP1l = i => /VP1l/.test(typeOf[i] || '');
      const vp1m = th.filter(isVP1m), vp1l = hy.filter(isVP1l);
      this.S[`thermosensory ${sd}`] = th.filter(i => !isVP1m(i)).concat(vp1l);
      this.S[`hygrosensory ${sd}`] = hy.filter(i => !isVP1l(i)).concat(vp1m);
      moved.toHygro += vp1m.length; moved.toThermo += vp1l.length;
    }
    return moved;
  }

  bindTypes(typeOf, sideOf, nerveLegOf) {
    this.taste = { labellum: {}, peg: {}, legs: {} };
    const N = typeOf.length;
    for (const [tst, types] of Object.entries(this.tasteTypes.labellum)) this.taste.labellum[tst] = [...Array(N).keys()].filter(i => types.includes(typeOf[i]));
    for (const [tst, types] of Object.entries(this.tasteTypes.peg)) this.taste.peg[tst] = [...Array(N).keys()].filter(i => types.includes(typeOf[i]));
    for (const leg of ['T1', 'T2', 'T3']) for (const sd of ['left', 'right']) {
      const legIdx = new Set(this.S[`taste ${leg} ${sd}`] || []);
      this.taste.legs[`${leg}_${sd}`] = Object.fromEntries(Object.entries(this.tasteTypes.leg).map(([tst, types]) => [tst, [...legIdx].filter(i => types.includes(typeOf[i]))]));
    }
    this.orn = {}; // glomerulus -> {left: idx[], right: idx[]}
    for (const s of this.bm.sensors) if (s.kind === 'odor') { (this.orn[s.glomerulus] ||= {})[s.antenna] = s.idx; }
    // Johnston's organ, split by subtype so a song excites the song cells. See SONG.
    // VP1m/VP1l corrected against Marin et al. (2020) before any channel reads these groups.
    this.vpFix = this.fixVPAssignments(typeOf);

    this.jo = { left: { B: [], A: [], C: [] }, right: { B: [], A: [], C: [] } };
    for (const sd of ['left', 'right']) {
      for (const i of (this.S[`JO auditory ${sd}`] || [])) {
        const t = typeOf[i] || '';
        const k = /^JO-B/.test(t) ? 'B' : /^JO-C/.test(t) ? 'C' : /^JO-A/.test(t) ? 'A' : 'A';
        this.jo[sd][k].push(i);
      }
    }
    this._songT = 0;
  }
  set(ix, hz) { for (const i of ix) { const r = this.rates.get(i) || 0; if (hz > r) this.rates.set(i, hz); } }
  static hill(c, k = 0.3, n = 1.5) { return c <= 0 ? 0 : Math.pow(c, n) / (Math.pow(c, n) + Math.pow(k, n)); }

  /** Compute all sensory rates for the current state. `st` holds positions from the physics step. */
  update(st, env, dtMs) {
    this.rates.clear();
    const H = Senses.hill;
    // --- olfaction: concentration at each antenna from static plumes (+ wind advection) and other flies ---
    for (const sd of ['left', 'right']) {
      const p = st.antenna[sd];
      const act = {};
      for (const o of env.odors) {
        const dx = p[0] - o.x - env.wind[0] * 0.5, dy = p[1] - o.y - env.wind[1] * 0.5;
        const c = o.strength * Math.exp(-(dx * dx + dy * dy) / (2 * o.sigma * o.sigma));
        for (const [g, sens] of Object.entries(ODORANTS[o.odor] || {})) act[g] = Math.max(act[g] || 0, c * sens);
      }
      for (const f of st.otherFlies) {
        const dx = p[0] - f.x, dy = p[1] - f.y;
        const c = FLY_ODOR.strength * Math.exp(-(dx * dx + dy * dy) / (2 * FLY_ODOR.sigma * FLY_ODOR.sigma));
        if (c > 0.02) for (const [g, sens] of Object.entries(ODORANTS.pheromone)) act[g] = Math.max(act[g] || 0, c * sens);
      }
      let evoked = 0; for (const g in act) evoked += 150 * H(act[g], 0.25, 1.4);
      const gain = AL_NORM / (AL_NORM + evoked);
      for (const [g, ixs] of Object.entries(this.orn)) {
        const ix = ixs[sd]; if (!ix) continue;
        this.set(ix, ORN_SPONTANEOUS + 150 * H(act[g] || 0, 0.25, 1.4) * gain);
      }
    }
    // --- taste: labellum and taste pegs (when proboscis touches the floor on food), tarsi ---
    const onPatch = (p, list) => { let best = null; for (const f of list) { const d = Math.hypot(p[0] - f.x, p[1] - f.y); if (d < f.r && (!best || f.sugar > best.sugar)) best = f; } return best; };
    const labTouch = st.labellumZ < 0.065; st.sugar = 0;   // strongest sugar taste anywhere this step (0..1)   // extended labellum within 0.65 mm of the substrate (see PLAN.md)
    if (labTouch) {
      const f = onPatch(st.labellum, env.food), b = onPatch(st.labellum, env.bitterPatches);
      if (f && f.amount > 0) { st.sugar = Math.max(st.sugar, f.sugar); this.set(this.taste.labellum.sugar, 180 * H(f.sugar * st.sugarGain, 0.2)); this.set(this.taste.labellum.water, 120 * H(f.water, 0.2)); if (st.proboscisOut) this.set(this.taste.peg.sugar, 150 * H(f.sugar, 0.2)); }
      if (b) this.set(this.taste.labellum.bitter, 180 * H(b.bitter * st.bitterGain, 0.2));
    }
    for (const leg of ['T1', 'T2', 'T3']) for (const sd of ['left', 'right']) {
      const key = `${leg}_${sd}`, touch = st.touch[key];
      const on = touch > 0 ? 1 : 0;
      if (on !== this.touchPrev[key]) this.touchBurst[key] = 1; this.touchPrev[key] = on;
      this.touchBurst[key] *= Math.exp(-dtMs / 15);
      // reafference: the stepping generator's efference copy presynaptically inhibits tarsal afferents during
      // self-generated steps, so footfalls are not mistaken for external touch (st.stepping: 0 still .. 1 walking)
      if (this.touchBurst[key] > 0.05) this.set(this.tarsal[key] || [], 180 * this.touchBurst[key] * (1 - REAFFERENCE * (st.stepping || 0)));
      if (touch > 0) {
        const p = st.claw[key], f = onPatch(p, env.food), b = onPatch(p, env.bitterPatches);
        if (f && f.amount > 0) st.sugar = Math.max(st.sugar, f.sugar);
        if (f && f.amount > 0) this.set(this.taste.legs[key].sugar, 150 * H(f.sugar * st.sugarGain, 0.2));
        if (b) this.set(this.taste.legs[key].bitter, 150 * H(b.bitter * st.bitterGain, 0.2));
        for (const other of st.otherFlies) if (Math.hypot(p[0] - other.x, p[1] - other.y) < 0.18) this.set(this.taste.legs[key].pheromone, 120);
      }
      // proprioception: population codes of joint angle (chordotonal: femur-tibia; hair plates: coxa), load (campaniform)
      const fe = st.joint[`tibia_${key}`], cx = st.joint[`coxa_${key}`], load = st.load[key];
      popCode(this, this.S[`chordotonal ${leg} ${sd}`], fe, -1.35, 1.3);
      popCode(this, this.S[`hair plate ${leg} ${sd}`], cx, -0.3, 1.7);
      if (load > 0) this.set(this.S[`campaniform ${leg} ${sd}`] || [], Math.min(200, 3000 * load));
    }
    // body bristles: contact of thorax/wings/abdomen with walls, obstacles or other flies
    for (const sd of ['left', 'right']) if (st.bodyContact[sd]) this.set(this.S[`wing/notum bristles ${sd}`] || [], 150);
    // an obstacle ahead: it deflects the antenna (Johnston's organ) and touches the front leg's bristles
    for (const sd of ['left', 'right']) if (st.frontTouch?.[sd]) { this.set(this.S[`JO wind/gravity ${sd}`] || [], 120); this.set(this.legBristle[`T1_${sd}`] || [], 150); }
    // halteres/gyro: angular velocity magnitude drives haltere campaniform populations (mostly relevant in flight)
    const w = Math.hypot(st.gyro[0], st.gyro[1], st.gyro[2]);
    for (const sd of ['left', 'right']) if (w > 2) this.set(this.S[`haltere ${sd}`] || [], Math.min(200, 10 * w));
    // antennal mechanosensation (JO): wind and self-motion air flow
    for (const sd of ['left', 'right']) { const air = Math.hypot(env.wind[0] - st.vel[0], env.wind[1] - st.vel[1]); if (air > 0.5) this.set(this.S[`JO wind/gravity ${sd}`] || [], Math.min(150, 20 * air)); }
    // --- courtship song: the one channel by which these flies talk to each other ---
    // A singing male vibrates one wing; that is near-field particle velocity, not pressure, and
    // Johnston's organ in the antenna is what detects it. Two consequences the model needs:
    // the range is short (particle velocity falls roughly as 1/r^2 in the near field, so song is
    // a courtship signal over millimetres, not a broadcast), and it is directional, because the
    // two antennae sit a little apart. Distance is therefore measured from each antenna
    // separately rather than from the body centre, which gives the bilateral difference for free.
    // The carrier (~250 Hz) is far above what a 1 ms step can represent, but the pulse train is
    // not: pulses are ~10 ms at ~35 ms intervals, and that interval is the species-recognition
    // cue, so it is modelled explicitly.
    // Singers are other flies plus, when Janus has something to say, Janus. He is given no
    // special channel: he sings into the same antennae, over the same near-field range, with the
    // same inter-pulse interval that carries species identity. English text reaches the human
    // watching and no part of the fly, so this is the only way an instruction from him is
    // something the animal can actually receive.
    const singers = [];
    for (const o of st.otherFlies) if (o.singing) singers.push({ x: o.x, y: o.y, z: o.z ?? 0.13, ipi: SONG.ipiMs, amp: 1 });
    const sg = env.song;
    if (sg && sg.on) singers.push({ x: sg.x, y: sg.y, z: sg.z ?? 0.13,
                                    ipi: sg.ipiMs || SONG.ipiMs, amp: sg.amp ?? 1, mode: sg.mode });
    st.song = 0;
    if (singers.length) {
      this.songPhase = (this.songPhase + dtMs) % SONG.ipiMs;
      for (const o of singers) {
        // Sine song is continuous; pulse song is a train, and the GAP is the signal. A singer with
        // its own inter-pulse interval keeps its own phase, because two IPIs is two utterances.
        const on = o.mode === 'sine' ? true
          : (o.ipi === SONG.ipiMs ? this.songPhase < SONG.pulseMs
                                  : (this._t2 = ((this._t2 || 0) + dtMs)) % o.ipi < SONG.pulseMs);
        if (!on) continue;
        for (const sd of ['left', 'right']) {
          const a = st.antenna[sd];
          const d = Math.hypot(a[0] - o.x, a[1] - o.y, a[2] - o.z);
          if (d > SONG.rangeCm) continue;
          const r = Math.max(d, SONG.refCm);
          const hz = Math.min(SONG.maxHz, SONG.maxHz * o.amp * (SONG.refCm / r) ** 2);
          const jo = this.jo[sd];
          if (SONG.wB) this.set(jo.B, hz * SONG.wB);
          if (SONG.wA) this.set(jo.A, hz * SONG.wA);
          if (SONG.wC) this.set(jo.C, hz * SONG.wC);
          st.song = Math.max(st.song, hz / SONG.maxHz);
        }
      }
    }
    // temperature: hot floor patches heat the fly (thermosensory neurons of the arista)
    st.heat = heatAt(st.pos, env);
    for (const sd of ['left', 'right']) { const h = heatAt(st.antenna[sd], env); if (h > 0.05) this.set(this.S[`thermosensory ${sd}`] || [], 200 * h); }
    // nociception -> PPL1 (off unless the host enabled it; see bindNociceptors)
    if (this.ppl && this.ppl.length) {
      const noxHeat = st.heat > NOCI.floor ? Senses.hill(st.heat, NOCI.heatK, 2.0) * NOCI.hz : 0;
      // bitter under the body, sampled the same way the tarsal receptors sample it
      let bit = 0;
      for (const b of env.bitterPatches) if (Math.hypot(st.pos[0] - b.x, st.pos[1] - b.y) < b.r) bit = Math.max(bit, b.bitter);
      const noxBitter = bit > NOCI.floor ? Senses.hill(bit, NOCI.bitterK, 2.0) * NOCI.bitterHz : 0;
      const nox = Math.max(noxHeat, noxBitter);
      if (nox > 0) this.set(this.ppl, nox);
      // reflex branch: the same noxious intensity onto the VNC afferent population, scaled to its
      // own rate. `nox` is already in Hz on the PPL scale, so convert back to the 0..1 fraction.
      if (nox > 0 && this.nociVnc && this.nociVnc.length) {
        this.set(this.nociVnc, (nox / NOCI.hz) * NOCI.vncHz);
      }
    }
    st.nox = (this.ppl && this.ppl.length && st.heat > NOCI.floor)
      ? Senses.hill(st.heat, NOCI.heatK, 2.0) : 0;
    // humidity: the 65 hygrosensory neurons sit in the antenna next to the thermosensory ones and
    // were never driven. The bodymap pools moist and dry cells into one group per side, so only
    // the moist response is modelled, and it is driven by the rise *above ambient* rather than by
    // the absolute level -- a gradient is what a fly can actually navigate, and a constant ambient
    // would otherwise hold the whole population at a fixed rate forever.
    st.humidity = humidityAt(st.pos, env);
    for (const sd of ['left', 'right']) {
      const q = humidityAt(st.antenna[sd], env) - (env.humidity ?? HUMID.base);
      if (q > 0.01) this.set(this.S[`hygrosensory ${sd}`] || [], Math.min(160, 320 * q));
    }
    return this.rates;
  }
}
function popCode(self, ix, q, lo, hi) {
  if (!ix || !ix.length || q === undefined) return;
  const n = ix.length, x = (q - lo) / (hi - lo), width = 0.25;
  for (let k = 0; k < n; k++) { const pref = (k + 0.5) / n; const r = 120 * Math.exp(-((x - pref) ** 2) / (2 * width * width)); if (r > 5) self.set([ix[k]], r); }
}

// --- compound eye: one ray per photoreceptor, luminance -> contrast-adapting rates ---
export class CompoundEye {
  constructor(mj, model, data, bodymap, headBodyId, thoraxBodyId) {
    this.mj = mj; this.model = model; this.data = data; this.head = headBodyId;
    const eyes = bodymap.eyes; this.idx = []; this.kind = []; const dirs = [];
    for (const e of eyes) e.idx.forEach((i, k) => {
      const az = e.az[k] * Math.PI / 180, el = e.el[k] * Math.PI / 180;
      dirs.push([Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)]);   // thorax frame: x fwd, y left, z up
      this.idx.push(i); this.kind.push(e.kind[k]); });
    this.n = dirs.length;
    // express directions in the head frame at rest so head movements rotate gaze
    mj.mj_forward(model, data);
    const Rh = data.xmat.slice(headBodyId * 9, headBodyId * 9 + 9), Rt = data.xmat.slice(thoraxBodyId * 9, thoraxBodyId * 9 + 9);
    this.dHead = new Float64Array(this.n * 3);
    for (let r = 0; r < this.n; r++) { const [x, y, z] = dirs[r];
      const w = [Rt[0] * x + Rt[1] * y + Rt[2] * z, Rt[3] * x + Rt[4] * y + Rt[5] * z, Rt[6] * x + Rt[7] * y + Rt[8] * z];  // thorax->world
      for (let c = 0; c < 3; c++) this.dHead[r * 3 + c] = Rh[c] * w[0] + Rh[3 + c] * w[1] + Rh[6 + c] * w[2]; }             // world->head
    this.vec = new Array(this.n * 3).fill(0);
    this.gid = new mj.IntBuffer(this.n); this.dist = new mj.DoubleBuffer(this.n); this.normal = new mj.DoubleBuffer(this.n * 3);
    this.adapt = new Float32Array(this.n).fill(-1);   // log-luminance adaptation state
    this.lum = new Float32Array(this.n);
    this.groups = [1, 0, 0, 0, 1, 0];                 // arena (group 0) + other flies' collision shapes (4)
  }
  /** returns luminance per photoreceptor; sets rates into `senses` */
  update(senses, env, dtMs, geomAlbedo) {
    const { mj, model, data, n, dHead, vec } = this; const h = this.head;
    const R = data.xmat.slice(h * 9, h * 9 + 9), o = [data.xpos[h * 3], data.xpos[h * 3 + 1], data.xpos[h * 3 + 2]];
    for (let r = 0; r < n; r++) { const x = dHead[r * 3], y = dHead[r * 3 + 1], z = dHead[r * 3 + 2];
      vec[r * 3] = R[0] * x + R[1] * y + R[2] * z; vec[r * 3 + 1] = R[3] * x + R[4] * y + R[5] * z; vec[r * 3 + 2] = R[6] * x + R[7] * y + R[8] * z; }
    mj.mj_multiRay(model, data, o, vec, this.groups, true, h, this.gid, this.dist, this.normal, n, 50);
    const gid = this.gid.GetView(), dist = this.dist.GetView(), sun = env.light.sun, sn = Math.hypot(...sun);
    const k = Math.min(1, dtMs / 300);   // photoreceptor light adaptation (~300 ms)
    for (let r = 0; r < n; r++) {
      const dz = vec[r * 3 + 2]; let L;
      if (gid[r] < 0) L = env.light.sky * (0.35 + 0.65 * Math.max(0, dz));                     // sky: brighter overhead
      else { const px = o[0] + vec[r * 3] * dist[r], py = o[1] + vec[r * 3 + 1] * dist[r], pz = o[2] + vec[r * 3 + 2] * dist[r];
        const alb = geomAlbedo(gid[r], px, py, pz); L = env.light.sky * alb * (0.35 + 0.65 * Math.max(0, -(vec[r * 3] * sun[0] + vec[r * 3 + 1] * sun[1] + vec[r * 3 + 2] * sun[2]) / sn * 0 + 1)); }
      const ll = Math.log(1e-3 + L); if (this.adapt[r] < -0.5 && this.adapt[r] === -1) this.adapt[r] = ll;
      this.adapt[r] += k * (ll - this.adapt[r]);
      this.lum[r] = L;
      const rate = Math.max(0, Math.min(250, 40 + 90 * (ll - this.adapt[r])));
      if (rate > 1) senses.set([this.idx[r]], rate);
    }
    return this.lum;
  }
}

/** horizontal clearance (cm) from point p to the nearest wall, obstacle or other fly; negative = inside.
 *  With a height z, obstacles and flies that are not at that height are ignored. */
export function clearance(p, env, others = [], z = null) {
  const [x, y] = p; const A = env.arena;
  // distance to the nearest wall, for whichever shape the arena is
  let d = A.shape === 'rect' ? Math.min(A.w - Math.abs(x), A.h - Math.abs(y))
                             : A.radius - Math.hypot(x, y);
  if (!(A.wallHeight > 0)) d = Infinity;              // open ground: nothing to run into
  for (const o of env.obstacles) {
    // o.z raises the underside (staircase treads); a raised tread is only in the way over its
    // own height band, so a fly can pass beneath one and above the step below it.
    const zb = o.z || 0;
    if (z !== null && (z > zb + o.sz + 0.05 || z < zb - 0.05)) continue;
    if (o.type === 'box') {
      let dx = x - o.x, dy = y - o.y;
      if (o.yaw) { const c = Math.cos(-o.yaw), s = Math.sin(-o.yaw), rx = c * dx - s * dy; dy = s * dx + c * dy; dx = rx; }   // into the box's own frame
      const qx = Math.abs(dx) - o.sx, qy = Math.abs(dy) - o.sy; d = Math.min(d, Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0));
    }
    else d = Math.min(d, Math.hypot(x - o.x, y - o.y) - o.r);
  }
  for (const f of others) if (z === null || Math.abs(z - (f.z ?? 0.13)) < 0.15) d = Math.min(d, Math.hypot(x - f.x, y - f.y) - 0.1);
  return d;
}
/** floor heat 0..1 at point p: full over a hot patch, fading over 4 mm around it */
// Humidity. The arena already has water in it -- every food patch carries a `water` fraction --
// so moist food is the obvious vapour source, with heat drying the air locally and wind mixing
// the excess back toward ambient. Hygrosensory neurons sit in the antenna alongside the
// thermosensory ones, which is why both are sampled per antenna rather than at the body.
export const HUMID = { base: 0.45, plumeCm: 0.55, fromWater: 0.5, dryPerHeat: 0.35, windMix: 0.25 };

export function humidityAt(p, env) {
  const base = env.humidity ?? HUMID.base;
  let h = base;
  for (const f of env.food || []) {
    if (!(f.water > 0) || !(f.amount > 0)) continue;
    const d = Math.max(0, Math.hypot(p[0] - f.x, p[1] - f.y) - f.r);   // from the patch edge, not its centre
    h += HUMID.fromWater * f.water * Math.exp(-(d * d) / (2 * HUMID.plumeCm * HUMID.plumeCm));
  }
  h -= HUMID.dryPerHeat * heatAt(p, env);                              // hot floor evaporates it away
  const w = Math.hypot(env.wind?.[0] || 0, env.wind?.[1] || 0);
  if (w > 0) h = base + (h - base) / (1 + HUMID.windMix * w);          // wind mixes the excess out
  return h < 0 ? 0 : h > 1 ? 1 : h;
}

// Nociception. `heatK` is the half-maximal noxious intensity and `hz` the saturating rate onto
// PPL1; `bitter` weights a noxious tastant against noxious heat. Values are chosen so that heat
// 0.5 -- the damage threshold, and the only punishment level safe to leave on -- produces a
// clear phasic rise without pinning the population, NOT fitted to physiology.
// `vncHz` is the saturating rate onto the VNC afferent population (see bindNociceptors). It is a
// separate knob from `hz` because the two branches are different things: `hz` drives a modulatory
// cluster of ~24 cells, `vncHz` drives ~1,564 primary afferents sitting one synapse from 42% of
// the motor pool. They should not share a magnitude.
export const NOCI = { heatK: 0.22, hz: 130, bitterK: 0.35, bitterHz: 90, floor: 0.06, vncHz: 130 };


/**
 * Floor heat at a point, INCLUDING its height.
 *
 * This used to ignore p[2] entirely, which meant a fly standing on a table or in mid-flight felt
 * exactly what a fly on the floor felt. Climbing and flying were therefore not escape routes from
 * a hot floor -- they were no-ops. Heat here is conducted and radiated from the substrate, so it
 * falls away above it: a standing fly's tarsi are at z ~ 0, its thorax at 0.13, a tabletop is at
 * 0.4-0.6, and flight is higher still. HEAT_Z sets the scale over which that relief arrives.
 */
const HEAT_Z = 0.28;                       // cm; ~1/e of the floor value per 0.28 cm of height
export function heatAt(p, env) {
  let heat = 0;
  for (const h of env.hazards) {
    const d = Math.hypot(p[0] - h.x, p[1] - h.y);
    heat = Math.max(heat, h.heat * Math.max(0, 1 - Math.max(0, d - h.r) / 0.4));
  }
  const z = Math.max(0, p[2] || 0);
  return heat * Math.exp(-z / HEAT_Z);
}

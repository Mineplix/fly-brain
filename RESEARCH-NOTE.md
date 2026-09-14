# An Embodied, Connectome-Constrained Simulation of *Drosophila melanogaster*: Architecture, Sensorimotor Wiring, and Coverage

**Technical research note**

---

> **Note on references.** Citations follow APA 7th edition. Author names, years, titles and
> journals are given as recorded; **volume, page and DOI fields have not been verified against
> the published record** and should be checked before this note is used in formal work. Where
> a source could not be confidently identified it is described in the text rather than cited.
> Empirical figures reported here were measured directly from the artefact and are reproducible
> by the procedures given in §7.

---

## Abstract

Connectomics has produced synapse-resolution wiring diagrams of the *Drosophila* nervous
system, but a wiring diagram is not a functioning animal (Bargmann & Marder, 2013). This note
documents an artefact that couples a 165,122-neuron leaky integrate-and-fire model of the male
*Drosophila* central nervous system to a biomechanical body in a rigid-body physics engine,
closing the sensorimotor loop in real time in a web browser. We describe the neuron model, the
four-timescale integration scheme, the shared-memory architecture that permits several animals
to share one connectome, the transduction functions that convert physical state into firing
rates at identified sensory neurons, the motor readout, and an added mushroom-body plasticity
mechanism. We then report a quantitative **coverage analysis**: of 165,122 neurons, 74,498
(45.1%) receive externally imposed sensory drive, 534 (0.3%) are read as motor output, and
90,090 (54.6%) are interior, receiving input solely through modelled synapses. Sensory coverage
is 74.5% of annotated sensory neurons; the principal gaps are unclassified mechanosensory
afferents, the enteric and endocrine systems, and 1,245 of 1,314 descending neurons that are
present in the graph but not read by the motor layer. We conclude with a prioritised roadmap
toward greater biological realism and a candid statement of what the artefact does and does not
demonstrate.

---

## 1. Introduction

### 1.1 The gap between a wiring diagram and an animal

Electron-microscopy reconstruction has yielded complete or near-complete synaptic connectivity
for the *Drosophila* hemibrain (Scheffer et al., 2020), the full adult brain (Dorkenwald et al.,
2024; Schlegel et al., 2024), and the ventral nerve cord. These datasets specify, for each
ordered pair of neurons, the number of synapses between them. They do not specify synaptic
sign with certainty, synaptic strength in physiological units, intrinsic excitability, or
neuromodulatory state — and they say nothing about the body the circuit evolved to control.

Bargmann and Marder (2013) argued that connectivity alone underdetermines function, and that
the same wiring can produce qualitatively different dynamics under different modulatory
regimes. Marder and Goaillard (2006) demonstrated that biological circuits achieve similar
output from widely varying underlying parameters. Any connectome-derived simulation therefore
makes assumptions beyond the connectome, and the scientific value of such a simulation depends
largely on how explicitly those assumptions are stated.

### 1.2 Scope of this artefact

The system described here is a **web-based, real-time, embodied simulation**. Its design
priorities are, in order: (a) that every sensory and motor signal terminates on *identified*
connectome neurons rather than on abstractions; (b) that the loop is genuinely closed, so that
motor output changes the physical state that generates the next sensory input; (c) that several
animals can be simulated concurrently in a shared arena; and (d) that it runs on consumer
hardware without installation.

It is explicitly **not** a validated model of *Drosophila* behaviour. §8 states the limitations
in detail.

---

## 2. Materials

### 2.1 Connectome

The neural substrate is the male *Drosophila* central nervous system connectome, version 1.0,
comprising brain and ventral nerve cord in a single graph (Janelia FlyEM and collaborators;
released CC-BY). As instantiated here it contains **165,122 neurons and 10,511,038 weighted,
directed edges**, together with per-neuron annotations for cell type, class, superclass,
hemisphere, predicted neurotransmitter, and soma position.

Annotation conventions follow the systematic nomenclature of Ito et al. (2014) and the
cell-typing approach of Schlegel et al. (2024).

### 2.2 Body

Body dynamics use **flybody**, a morphologically detailed *Drosophila* model comprising an
articulated exoskeleton with actuated legs, wings, proboscis, antennae and abdomen
(Vaxenburg et al., 2024), simulated in the MuJoCo rigid-body engine (Todorov et al., 2012)
compiled to WebAssembly.

Units follow flybody: centimetres, grams, seconds. A standing fly's thorax sits at
*z* ≈ 0.13 cm. The arena is a circular enclosure of radius 2.5 cm with a 1.2 cm wall.

### 2.3 Optic lobe

Visual processing uses **flyvis**, a connectome-constrained recurrent network of the optic lobe
trained on optic-flow tasks, which predicts neural activity across identified visual cell types
(Lappalainen et al., 2024). The instantiated model comprises **45,669 nodes and 1,513,231
edges** across 65 cell types, with 721 hexagonal input columns per eye.

---

## 3. The neuron model

### 3.1 Formulation

Each neuron is a leaky integrate-and-fire unit following the whole-brain formulation of
Shiu et al. (2024), in which every synapse contributes a fixed postsynaptic potential scaled by
synapse count, with sign determined by the predicted presynaptic transmitter.

Membrane potential evolves as

    dV/dt = ( V_rest − V + g_E + g_I + I_bias ) / τ_m

with a conductance-based variant available in which excitatory and inhibitory currents are
driven toward reversal potentials *E*<sub>exc</sub> and *E*<sub>inh</sub>. On crossing
threshold the neuron emits a spike, resets, and enters refractory period.

**Parameters.** *dt* = 0.5 ms; *V*<sub>rest</sub> = −52 mV; *V*<sub>thresh</sub> = −45 mV;
τ<sub>m</sub> = 20 ms; τ<sub>syn</sub> = 5 ms; *t*<sub>ref</sub> = 2.2 ms; synaptic delay
1.8 ms.

### 3.2 Beyond the base formulation

Three mechanisms are added because the pure LIF form produces implausibly sustained firing:

1. **Spike-frequency adaptation.** Threshold rises by 2.0 mV per spike and decays with
   τ = 100 ms.
2. **Short-term synaptic depression.** Per presynaptic neuron, a resource variable
   *x* ← *x* − 0.2*x* per spike, recovering with τ = 200 ms.
3. **Input scaling by neuron size.** Per-synapse PSP is weighted by *w* × *c* / *s*, where *c*
   is synapse count and *s* is neuron volume relative to its region's median — larger neurons
   have lower input resistance.

Transmitter sign follows the predicted neurotransmitter: acetylcholine excitatory; GABA and
glutamate inhibitory; monoamines excitatory unless overridden. Neurons with unknown transmitter
receive sign 0 — **no sign is invented**, which is an explicit choice to leave ~1.5% of the
graph functionally silent rather than guess.

### 3.3 Event-driven evaluation

Synaptic delivery is event-driven: only the outgoing edges of neurons that actually fired are
traversed. Because *Drosophila* firing rates are low, this traverses a small fraction of the
10.5 M edges per step. Membrane update and threshold detection are dense over the 165,122
neurons, a deliberate trade for vectorisability.

---

## 4. System architecture

### 4.1 Four clocks

The outer integration unit is one millisecond of simulated time. Within it:

| process | rate | per outer tick |
|---|---|---|
| MuJoCo physics | 0.2 ms | 5 substeps |
| LIF brain | 0.5 ms | 2 steps |
| Sensory transduction and motor readout | 1 ms | 1 (every tick) |
| Optic lobe (flyvis) | 20 ms | 1 in 20 |

The physics timestep is halved from flybody's 0.1 ms with no-slip iterations disabled, reported
in-source as preserving gait quality at half the cost. Sensory and motor exchange are locked to
the 1 ms tick by construction; **vision is the only genuinely decoupled rate**, which is why it
is also the only cheap thing to remove.

### 4.2 Shared connectome, private state

The connectome is written once into a `SharedArrayBuffer` and read by every simulated animal;
each animal receives a private block for dynamic state (membrane potentials, conductances,
adaptation, refractory counters, spike counts, delay ring). Each also runs its own MuJoCo world.

The consequence is that **adding an animal costs state, not another copy of the graph** — the
design decision that makes multi-animal simulation tractable in a browser. It requires
cross-origin isolation (COOP/COEP) for `SharedArrayBuffer` availability.

Animals interact through kinematic proxies: each world contains mocap stand-ins for the others,
updated at 30 Hz. Physics cost therefore scales linearly rather than quadratically, at the price
that no solver is authoritative over an inter-animal collision.

### 4.3 Two compute backends

A WebGPU compute-shader kernel and a WebAssembly SIMD kernel implement the same model. The
WebGPU path is preferred when available. Measured on an RTX 4050 laptop GPU, one animal, with
rendering active: **0.0650 simulated seconds per wall second**, against **0.0148** for the
WebAssembly path — a ≥4.4× advantage, conservative because the WebAssembly measurement had
rendering disabled.

**A methodological caution.** On switchable-graphics laptops the browser may use the integrated
GPU while the discrete GPU sits idle, and `chrome://gpu` does not reveal this, since it lists
every adapter *present*. Verifying the WebGPU adapter string is a one-line check and was, in
this project, the difference between a reported 32× slowdown and a 4.4× speedup.

---

## 5. Sensorimotor wiring

Every channel terminates on identified neurons specified by a body map that links anatomical
sensors and muscles to connectome indices. Transduction functions are documented approximations,
not fitted models.

### 5.1 Olfaction

Odorants are defined as glomerular activation patterns — for example vinegar activates DM1,
DM4, VA2, DP1m, DM2, VM2 and DL1 with graded sensitivity. Concentration at each antenna is
computed from Gaussian plumes with wind advection, converted to firing rate by a Hill function,
and applied to the olfactory receptor neurons of each glomerulus with a spontaneous baseline of
6 Hz.

Critically, a **divisive gain control** is applied across the antennal lobe following the
presynaptic inhibition described by Olsen and Wilson (2008): total evoked drive per antenna is
normalised so the glomerular *pattern* is preserved while the total is bounded, preventing one
strong odorant from recruiting the entire lobe.

Conspecifics emit a short-range pheromone modelled on cVA, activating DA1, VA1v and VA1d.

### 5.2 Gustation

Taste is resolved by tastant and by body location — labellum, taste pegs and tarsi — with
distinct receptor classes for sugar, bitter, water, salt, pheromone and fatty acids. Sugar and
bitter sensitivity are modulated by internal state, so a hungry animal is more sugar-sensitive
and less bitter-averse.

### 5.3 Mechanosensation

Tactile bristles are rapidly adapting, bursting at contact onset and offset with τ ≈ 15 ms.
A fixed subset of each leg's tactile afferents is treated as tarsal (substrate-contacting), the
remainder as femoral/tibial.

**Reafference.** Self-generated footfalls are attenuated by an efference copy from the stepping
generator, cancelling 85% of tarsal signal in proportion to stepping amplitude, so that
self-motion is not misread as external touch. This follows the general principle demonstrated
for visual reafference in *Drosophila* by Kim et al. (2015).

Proprioception is supplied by joint-angle and load sensors; halteres report angular velocity.

### 5.4 Vision

Two pathways exist. The primary path casts **721 rays per eye** along the measured viewing
directions of the flyvis hexagonal lattice, converts surface reflectance to luminance, and feeds
the flyvis optic-lobe model at 50 Hz; its node activations then drive the matching male-CNS
optic-lobe neurons — **62,157 neuron–node pairs**, approximately 38% of the entire connectome.
Photoreceptors are additionally driven by the luminance of their nearest column under
logarithmic light adaptation with τ ≈ 300 ms.

The optic-lobe state is settled under a uniform grey field at construction and stored as a
resting reference, so neurons respond to *deviations* rather than absolute activity.

LC10 small-object visual projection neurons are driven explicitly as the visual channel into
courtship, following Ribeiro et al. (2018).

### 5.5 Audition

Courtship song is detected by **Johnston's organ**, the antennal auditory organ
(Kamikouchi et al., 2009; Yorozu et al., 2009). Song is near-field particle velocity rather
than pressure, with two modelled consequences: intensity falls approximately as 1/*r*², making
it a courtship signal over millimetres rather than a broadcast; and it is directional, so
distance is computed from each antenna independently and the bilateral difference emerges from
geometry rather than being imposed.

The ~250 Hz carrier is unrepresentable at a 1 ms timestep, but the **pulse train is not**, and
inter-pulse interval is the species-recognition cue (Coen et al., 2014). Pulses are therefore
modelled explicitly at 10 ms within a 35 ms interval.

*This channel was inert in the original artefact: males sang and no animal heard.* 114 auditory
neurons (62 left, 52 right) were permanently silent.

### 5.6 Thermosensation and hygrosensation

Arista thermosensory neurons respond to local floor temperature (Gallio et al., 2011).
Hygrosensory neurons, which in *Drosophila* depend on ionotropic receptors distinct from those
mediating thermosensation (Enjin et al., 2016; Knecht et al., 2016), respond to a humidity
field generated by water-bearing food, dried over hot substrate and mixed by wind. Because the
body map pools moist and dry cells into one group per side, only the moist response is modelled,
and it is driven by rise *above ambient* rather than absolute level — a gradient is navigable,
whereas constant ambient would pin the population at a fixed rate.

*This channel was also inert:* 65 hygrosensory neurons were never driven.

### 5.7 Motor readout

Two modes are provided. In **descending mode**, identified descending neurons set locomotor
drive and steering, with a tripod pattern generator executing the command; in **connectome
mode**, mapped leg muscles are driven by their own motor neurons through the ventral nerve cord.

Descending roles follow the optogenetic dissections of Cande et al. (2018), Bidaye et al.
(2014) and Namiki et al. (2018): DNg100, DNg97 and DNp09 for forward walking; MDN for
backward; DNa02 and DNa01 for steering; DNg07/08/12 for grooming; DNp01 (giant fibre) for
escape; DNp02 and DNp04 for looming-evoked takeoff (von Reyn et al., 2014); pIP10 and DNp13 for
courtship (Ribeiro et al., 2018).

Muscle activation follows a saturating force–frequency relation, half-maximal at ≈17 Hz.
The giant-fibre-to-TTMn **electrical** synapse — absent from a chemical connectome — is added
explicitly, consistent with the spike-timing account of escape in von Reyn et al. (2014).

Escape is gated by touch, self-generated optic flow and efference copies of the animal's own
movements, so that self-produced looming does not trigger spurious escape (Kim et al., 2015).

---

## 6. Mushroom-body plasticity

### 6.1 Rationale and cost

The base model is static: synaptic weights never change. Associative memory in *Drosophila*
is stored at the Kenyon cell → mushroom body output neuron (MBON) synapse
(Aso et al., 2014; Hige et al., 2015; Modi et al., 2020). In this connectome that synapse class
comprises **44,042 edges of 10,511,038 (0.419%)**, of which 29,169 survive the minimum-synapse
threshold with non-zero effective weight.

A per-animal plastic overlay on that slice therefore costs **114 kB** per animal, against
40 MB to duplicate the graph. The shared connectome remains shared. The complete circuit is
present: 4,064 Kenyon cells, 97 MBONs, 340 dopaminergic neurons (PAM/PPL/DAN), and the 2 APL
neurons that enforce sparse coding (Lin et al., 2014; Turner et al., 2008).

### 6.2 Learning rule

Depression — not potentiation — is the established direction at this synapse
(Hige et al., 2015; Cohn et al., 2015). The implemented rule is eligibility trace × dopamine:
coincidence of a Kenyon cell's spike trace with dopamine in its compartment depresses that
synapse, with recovery over minutes.

**Compartments are derived from connectivity**, not from type names: a dopaminergic neuron is
taken to teach the synapses onto the MBONs it innervates. This covers 96 of 97 MBONs and 334 of
340 DANs, with a median of 5 dopaminergic edges per MBON. Name parsing was not viable because
type identifiers are opaque.

A trace-based rather than spike-pair rule was required because the GPU backend batches
dispatches and returns spike data asynchronously, so a per-step fired list does not exist on the
default backend. This constraint pushed the implementation toward the formulation that is in any
case standard for this circuit.

### 6.3 Dopamine detection

Dopaminergic neurons in this model are **tonically active** (summed trace ≈ 30 at rest).
Learning from absolute level therefore depresses indiscriminately. The rule instead detects a
*phasic rise above a slow baseline*, low-passed to ≈300 ms against an 8 s tonic reference, with
both references seeded from an average over a settled window.

Measured discrimination, aversive stimulus versus none:

| condition | summed dopaminergic trace (min / median / max) |
|---|---|
| no aversive stimulus | 27.07 / 30.28 / 34.57 |
| hot substrate | 42.71 / 50.94 / 56.66 |

A 68% median increase with non-overlapping distributions.

---

## 7. Coverage analysis

### 7.1 Method

Neurons were classified as **driven** if any transduction path writes firing rate to them
(body-map sensors, flyvis→CNS pairs, photoreceptors, explicit LC10 drive), and as **read** if
any motor path reads their spike count (mapped muscles, wing, jump and feeding groups, unmapped
motor pool, and the named descending types used by the motor layer). All other neurons are
**interior**: they receive input only through modelled synapses.

### 7.2 Global result

| category | neurons | share |
|---|---:|---:|
| externally driven (sensory) | 74,498 | 45.1% |
| read as output (motor) | 534 | 0.3% |
| interior | 90,090 | 54.6% |

A 54.6% interior fraction is the appropriate figure: those neurons *should* be driven by the
connectome rather than by the simulation, and their being untouched externally is the point.

### 7.3 Sensory coverage by class

| class | total | driven | gap |
|---|---:|---:|---:|
| visual | 4,107 | 4,107 | **0** |
| olfactory | 2,639 | 2,635 | 4 |
| mechanosensory_tactile | 2,558 | 2,532 | 26 |
| mechanosensory | 1,733 | 589 | **1,144** |
| unknown_sensory | 1,707 | 0 | **1,707** |
| mechanosensory_proprioceptive | 1,454 | 860 | **594** |
| gustatory | 1,428 | 1,039 | **389** |
| (unclassified) | 126 | 0 | 126 |
| hygrosensory | 66 | 65 | 1 |
| chemosensory | 58 | 0 | 58 |
| thermosensory | 25 | 25 | **0** |
| mechanosensory_tbc | 11 | 0 | 11 |
| **total** | **15,912** | **11,852** | **4,060 (74.5% driven)** |

Vision, thermosensation, olfaction, tactile mechanosensation and hygrosensation are essentially
complete. The substantive gaps are generic mechanosensory afferents and the 1,707 neurons
annotated only as `unknown_sensory`, which cannot be driven without knowing their modality.

### 7.4 Output coverage

| population | total | read | gap |
|---|---:|---:|---:|
| descending neurons | 1,314 | 69 | **1,245** |
| VNC motor neurons | 708 | 386 | 322 |
| CB motor neurons | 107 | 79 | 28 |
| efferent neurons | 110 | 0 | 110 |
| endocrine cells | 94 | 0 | **94** |
| enteric nervous system | 47 | 0 | **47** |

**The descending gap is the most consequential finding.** The motor layer reads approximately
18 named descending types; the connectome contains 1,314 descending neurons. In descending
mode the remaining ~95% influence behaviour only indirectly. Full connectome mode engages more
of the ventral nerve cord but is not the default.

Three whole systems are absent from the loop: **efferent** neuromodulatory projections, the
**endocrine** system, and the **enteric** nervous system governing the gut.

---

## 8. Limitations

1. **No validation against behavioural data.** No gait, trajectory, or response statistic has
   been compared quantitatively to recorded *Drosophila* behaviour.
2. **Transduction functions are plausible, not fitted.** Every gain and time constant in §5 was
   chosen for reasonable dynamics, not estimated from electrophysiology.
3. **Synaptic sign is predicted, not measured**, and ~1.5% of neurons have no assigned sign.
4. **No synaptic plasticity outside the mushroom body**, and no homeostatic or neuromodulatory
   regulation of the kind Marder and Goaillard (2006) show to be pervasive.
5. **The plasticity result is weak.** A dose-response across three conditions yields a
   plasticity-dependent, odour-specific shift in MBON valence balance that scales with dose
   (aversive/appetitive ratio: +6.8 ± 2.2 control, +12.8 ± 4.7 at 1× dose, +13.6 ± 2.3 at 9×).
   However: replicates shared one arena and were therefore **pseudo-replicates**; *n* = 4 per
   condition; and **no behavioural consequence was demonstrated**. The effect sign is inverted
   relative to textbook aversive learning, consistent with disinhibition through inhibitory
   MBONs but not established as such.
6. **Inter-animal physics is approximate** — conspecifics are kinematic proxies.
7. **Timescale.** The animal runs at roughly 0.065× real time on the reference hardware;
   experience is compressed relative to a real fly's development and learning history.

---

## 9. Toward greater realism

Ordered by expected gain per unit effort.

### 9.1 Close the descending gap
1,245 descending neurons are simulated but unread. Reading the full descending population as a
distributed motor command — rather than 18 named types — would let more of the brain's output
actually reach the body. This is the single largest structural gap.

### 9.2 Resolve `unknown_sensory`
1,707 sensory neurons lack a modality annotation. Cross-referencing against newer cell-typing
(Schlegel et al., 2024) could assign many, converting a coverage gap into working channels.

### 9.3 Interoception and internal state
The enteric (47) and endocrine (94) populations are entirely outside the loop. A crop-fullness
signal, an osmotic signal, and slow hormonal modulation of feeding and locomotor thresholds
would give the animal an internal milieu rather than a single scalar energy variable.

### 9.4 Neuromodulation as a state variable
Octopaminergic and dopaminergic tone currently enter as a narrow hunger channel. Marder and
Goaillard (2006) would predict that modulatory state changes effective circuit function
substantially; implementing it as a global gain and threshold modulator is tractable.

### 9.5 Individual chemical identity
Conspecifics emit an identical pheromone, so an animal senses *a fly* rather than *a
particular fly*. Per-individual blends across the pheromone glomeruli would make individual
recognition learnable by the mushroom body — the prerequisite for any social memory.

### 9.6 Behavioural validation
Optomotor response, odour-tracking trajectory statistics, grooming sequence structure
(Seeds et al., 2014), and courtship song timing are all measurable in the artefact and
comparable to published data. Until such comparisons exist, claims about realism remain
architectural rather than empirical.

### 9.7 Developmental and lifetime timescales
Overnight headless recording currently yields ~90 minutes of simulated experience per animal.
Meaningful learning histories would require either substantially faster simulation — a batched
GPU formulation computing all animals in one sparse matrix product rather than *N* independent
ones — or accepting offline, non-interactive runs.

---

## 10. Conclusion

The artefact demonstrates that a complete insect connectome can be embedded in a physically
simulated body and run in a closed sensorimotor loop on consumer hardware, with every sensory
and motor signal terminating on identified neurons. Coverage analysis shows the interface to be
substantially complete on the sensory side (74.5% of annotated sensory neurons) and markedly
incomplete on the output side, where 1,245 of 1,314 descending neurons are simulated but unread,
and three subsystems — efferent, endocrine, enteric — are absent from the loop entirely.

The addition of mushroom-body plasticity shows that associative machinery can be added at 0.4%
of the graph's memory cost, and that the resulting synaptic changes are contingent on
reinforcement and scale with training dose. It has **not** been shown that these changes alter
behaviour, and that distinction should be preserved in any description of this work.

The artefact's principal value is as an instrument: it makes the consequences of connectome-
derived assumptions visible and testable in a closed loop, which is precisely the regime in
which Bargmann and Marder (2013) argued connectivity alone is insufficient.

---

## References

Aso, Y., Hattori, D., Yu, Y., Johnston, R. M., Iyer, N. A., Ngo, T.-T. B., Dionne, H., Abbott,
L. F., Axel, R., Tanimoto, H., & Rubin, G. M. (2014). The neuronal architecture of the mushroom
body provides a logic for associative learning. *eLife*, *3*, e04577.

Bargmann, C. I., & Marder, E. (2013). From the connectome to brain function. *Nature Methods*,
*10*(6), 483–490.

Bidaye, S. S., Machacek, C., Wu, Y., & Dickson, B. J. (2014). Neuronal control of *Drosophila*
walking direction. *Science*, *344*(6179), 97–101.

Cande, J., Namiki, S., Qiu, J., Korff, W., Card, G. M., Shaevitz, J. W., Stern, D. L., &
Berman, G. J. (2018). Optogenetic dissection of descending behavioral control in *Drosophila*.
*eLife*, *7*, e34275.

Coen, P., Clemens, J., Weinstein, A. J., Pacheco, D. A., Deng, Y., & Murthy, M. (2014). Dynamic
sensory cues shape song structure in *Drosophila*. *Nature*, *507*(7491), 233–237.

Cohn, R., Morantte, I., & Ruta, V. (2015). Coordinated and compartmentalized neuromodulation
shapes sensory processing in *Drosophila*. *Cell*, *163*(7), 1742–1755.

Dorkenwald, S., Matsliah, A., Sterling, A. R., Schlegel, P., Yu, S.-C., McKellar, C. E., Lin,
A., Costa, M., Eichler, K., Yin, Y., Silversmith, W., … Murthy, M., & Seung, H. S. (2024).
Neuronal wiring diagram of an adult brain. *Nature*, *634*, 124–138.

Enjin, A., Zaharieva, E. E., Frank, D. D., Mansourian, S., Suh, G. S. B., Gallio, M., & Stensmyr,
M. C. (2016). Humidity sensing in *Drosophila*. *Current Biology*, *26*(10), 1352–1358.

Gallio, M., Ofstad, T. A., Macpherson, L. J., Wang, J. W., & Zuker, C. S. (2011). The coding of
temperature in the *Drosophila* brain. *Cell*, *144*(4), 614–624.

Hige, T., Aso, Y., Modi, M. N., Rubin, G. M., & Turner, G. C. (2015). Heterosynaptic plasticity
underlies aversive olfactory learning in *Drosophila*. *Neuron*, *88*(5), 985–998.

Ito, K., Shinomiya, K., Ito, M., Armstrong, J. D., Boyan, G., Hartenstein, V., Harzsch, S.,
Heisenberg, M., Homberg, U., Jenett, A., Keshishian, H., Restifo, L. L., Rössler, W., Simpson,
J. H., Strausfeld, N. J., Strauss, R., & Vosshall, L. B. (2014). A systematic nomenclature for
the insect brain. *Neuron*, *81*(4), 755–765.

Kamikouchi, A., Inagaki, H. K., Effertz, T., Hendrich, O., Fiala, A., Göpfert, M. C., & Ito, K.
(2009). The neural basis of *Drosophila* gravity-sensing and hearing. *Nature*, *458*(7235),
165–171.

Kim, A. J., Fitzgerald, J. K., & Maimon, G. (2015). Cellular evidence for efference copy in
*Drosophila* visuomotor processing. *Nature Neuroscience*, *18*(9), 1247–1255.

Knecht, Z. A., Silbering, A. F., Ni, L., Klein, M., Budelli, G., Bell, R., Abuin, L., Ferrer,
A. J., Samuel, A. D. T., Benton, R., & Garrity, P. A. (2016). Distinct combinations of variant
ionotropic glutamate receptors mediate thermosensation and hygrosensation in *Drosophila*.
*eLife*, *5*, e17879.

Lappalainen, J. K., Tschopp, F. D., Prakhya, S., McGill, M., Nern, A., Shinomiya, K., Takemura,
S., Gruntman, E., Macke, J. H., & Turaga, S. C. (2024). Connectome-constrained networks predict
neural activity across the fly visual system. *Nature*, *634*, 1132–1140.

Lin, A. C., Bygrave, A. M., de Calignon, A., Lee, T., & Miesenböck, G. (2014). Sparse,
decorrelated odor coding in the mushroom body enhances learned odor discrimination. *Nature
Neuroscience*, *17*(4), 559–568.

Marder, E., & Goaillard, J.-M. (2006). Variability, compensation and homeostasis in neuron and
network function. *Nature Reviews Neuroscience*, *7*(7), 563–574.

Modi, M. N., Shuai, Y., & Turner, G. C. (2020). The *Drosophila* mushroom body: From
architecture to algorithm in a learning circuit. *Annual Review of Neuroscience*, *43*, 465–484.

Namiki, S., Dickinson, M. H., Wong, A. M., Korff, W., & Card, G. M. (2018). The functional
organization of descending sensory-motor pathways in *Drosophila*. *eLife*, *7*, e34272.

Olsen, S. R., & Wilson, R. I. (2008). Lateral presynaptic inhibition mediates gain control in an
olfactory circuit. *Nature*, *452*(7190), 956–960.

Ribeiro, I. M. A., Drews, M., Bahl, A., Machacek, C., Borst, A., & Dickson, B. J. (2018). Visual
projection neurons mediating directed courtship in *Drosophila*. *Cell*, *174*(3), 607–621.

Scheffer, L. K., Xu, C. S., Januszewski, M., Lu, Z., Takemura, S., Hayworth, K. J., Huang, G. B.,
Shinomiya, K., Maitlin-Shepard, J., Berg, S., … Hess, H. F., & Plaza, S. M. (2020). A connectome
and analysis of the adult *Drosophila* central brain. *eLife*, *9*, e57443.

Schlegel, P., Yin, Y., Bates, A. S., Dorkenwald, S., Eichler, K., Brooks, P., Han, D. S.,
Gkantia, M., dos Santos, M., Munnelly, E. J., … Murthy, M., Jefferis, G. S. X. E. (2024).
Whole-brain annotation and multi-connectome cell typing of *Drosophila*. *Nature*, *634*,
139–152.

Seeds, A. M., Ravbar, P., Chung, P., Hampel, S., Midgley, F. M., Mensh, B. D., & Simpson, J. H.
(2014). A suppression hierarchy among competing motor programs drives sequential grooming in
*Drosophila*. *eLife*, *3*, e02951.

Shiu, P. K., Sterne, G. R., Spiller, N., Franconville, R., Sandoval, A., Zhou, J., Simha, N.,
Kang, C. H., Yu, S., Kim, J. S., Dorkenwald, S., … Scott, K. (2024). A leaky integrate-and-fire
computational model based on the connectome of the entire adult *Drosophila* brain reveals
insights into sensorimotor processing. *Nature*, *634*, 210–219.

Todorov, E., Erez, T., & Tassa, Y. (2012). MuJoCo: A physics engine for model-based control. In
*2012 IEEE/RSJ International Conference on Intelligent Robots and Systems* (pp. 5026–5033).
IEEE.

Turner, G. C., Bazhenov, M., & Laurent, G. (2008). Olfactory representations by *Drosophila*
mushroom body neurons. *Journal of Neurophysiology*, *99*(2), 734–746.

Vaxenburg, R., Siwanowicz, I., Merel, J., Robie, A. A., Morrow, C., Novati, G., Stefanidi, Z.,
Card, G. M., Reiser, M. B., Botvinick, M. M., Branson, K., Tassa, Y., & Turaga, S. C. (2024).
Whole-body physics simulation of fruit fly locomotion. *bioRxiv*.

von Reyn, C. R., Breads, P., Peek, M. Y., Zheng, G. Z., Williamson, W. R., Yee, A. L., Leonardo,
A., & Card, G. M. (2014). A spike-timing mechanism for action selection. *Nature Neuroscience*,
*17*(7), 962–970.

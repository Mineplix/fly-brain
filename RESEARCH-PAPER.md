# A Connectome-Constrained Embodied *Drosophila*: Closing the Sensorimotor Loop, and What It Takes to Make One Learn

**PROJECT: NAF — Neural Assessment of Flies**

*Technical research paper. Supersedes and extends `RESEARCH-NOTE.md`.*

---

> **Note on references and evidence.** Citations follow APA 7. Author names, years, titles and
> journals are given as recorded; volume, page and DOI fields have **not** been verified against the
> published record and should be checked before this paper is used in formal work. Every numeric
> result below was measured directly from the artefact, and each is reported with the procedure that
> produced it. Results that did not survive their own controls are reported as failures rather than
> omitted; Sections 8 and 10 exist largely for that purpose.

---

## Abstract

Connectomics has produced synapse-resolution wiring diagrams of the *Drosophila* nervous system, but
a wiring diagram is not an animal (Bargmann & Marder, 2013). We describe an artefact that couples a
165,122-neuron leaky integrate-and-fire model of the male *Drosophila* central nervous system to a
biomechanical body in a rigid-body physics engine, closing the sensorimotor loop in real time in a
web browser, with several animals sharing one connectome through shared memory.

We report three principal findings. First, a **coverage analysis**: 45.1% of neurons receive
externally imposed sensory drive, 0.3% are read as motor output, and 54.6% are interior; sensory
coverage reaches 74.5% of annotated sensory neurons, while 1,245 of 1,314 descending neurons are
simulated but never read.

Second, and centrally, **associative learning was impossible in this model for a reason that is a
property of the dataset rather than of the parameters**. Aversive stimuli raised the dopaminergic
population trace by only ~11%, against the ~68% the plasticity gate was calibrated against. Graph
analysis showed why: the 25 neurons annotated "thermosensory" are arista cells reporting *preferred*
temperature, not nociceptors, and reach the PPL1 dopaminergic cluster over only 103 two-hop paths.
The afferents that carry noxious signals are class IV multidendritic neurons — peripheral, and
therefore almost entirely outside a central-brain EM volume. Supplying that missing afferent
explicitly produced a teaching signal that passes its own control: 0 synapses depressed at rest
against 4,176 under punishment. A naturally learned memory was then shown to survive a page reload
intact.

Third, a set of **methodological results about measuring such a system at all**, including a
counter-intuitive one: furnishing the arena makes the simulation 1.7× *faster*, because ray casting
dominates per-fly cost and clutter terminates rays early.

We also report a **failed experiment** on persistent defensive arousal, and the design faults that
invalidated it.

---

## 1. Introduction

### 1.1 The gap between a wiring diagram and an animal

Electron-microscopy reconstruction has yielded near-complete synaptic connectivity for the
*Drosophila* hemibrain (Scheffer et al., 2020), the full adult brain (Dorkenwald et al., 2024;
Schlegel et al., 2024), and the ventral nerve cord. These datasets specify, for each ordered pair of
neurons, a synapse count. They do not specify synaptic sign with certainty, synaptic strength in
physiological units, intrinsic excitability, or neuromodulatory state — and they say nothing about
the body the circuit evolved to control.

Bargmann and Marder (2013) argued that connectivity alone underdetermines function, and Marder and
Goaillard (2006) showed that biological circuits reach similar output from widely varying underlying
parameters. Any connectome-derived simulation therefore makes assumptions beyond the connectome, and
its scientific value depends largely on how explicitly those assumptions are stated.

This paper takes that seriously in one specific way. Section 7 documents a case where the missing
information was not a parameter but an entire afferent population, where no amount of tuning could
have compensated, and where the correct response was to add the missing pathway explicitly and flag
every result that depends on it.

### 1.2 Scope

The system is a browser-based, real-time, embodied simulation whose design priorities are, in order:
that every sensory and motor signal terminates on identified connectome neurons rather than on
abstractions; that the loop is genuinely closed, so motor output changes the physical state
generating the next sensory input; that several animals can share one arena; and that it runs on
consumer hardware without installation.

It is **not** a validated model of *Drosophila* behaviour. Section 10 states the limitations.

---

## 2. Materials

**Connectome.** The male *Drosophila* central nervous system connectome, version 1.0 (brain and
ventral nerve cord in one graph), as instantiated here: **165,122 neurons and 10,511,038 weighted
directed edges**, with per-neuron annotations for cell type, class, superclass, hemisphere, predicted
neurotransmitter and soma position. Nomenclature follows Ito et al. (2014); cell typing follows
Schlegel et al. (2024).

**Body.** flybody, a morphologically detailed *Drosophila* model with actuated legs, wings,
proboscis, antennae and abdomen (Vaxenburg et al., 2024), simulated in MuJoCo (Todorov et al., 2012)
compiled to WebAssembly. Units are centimetres, grams, seconds; a standing fly's thorax sits at
z ≈ 0.13 cm.

**Optic lobe.** flyvis, a connectome-constrained recurrent model of the optic lobe trained on
optic-flow tasks (Lappalainen et al., 2024): **45,669 nodes, 1,513,231 edges, 65 cell types, 721
hexagonal input columns per eye**.

---

## 3. The neuron model

Each neuron is a leaky integrate-and-fire unit following the whole-brain formulation of Shiu et al.
(2024): every synapse contributes a fixed postsynaptic potential scaled by synapse count, signed by
the predicted presynaptic transmitter.

```
dV/dt = ( V_rest − V + g_E + g_I + I_bias ) / τ_m
```

**Parameters.** dt = 0.5 ms; V_rest = −52 mV; V_thresh = −45 mV; τ_m = 20 ms; τ_syn = 5 ms;
t_ref = 2.2 ms; synaptic delay 1.8 ms.

**Three additions**, because the pure LIF form produces implausibly sustained firing: spike-frequency
adaptation (threshold +2.0 mV per spike, decaying with τ = 100 ms); short-term synaptic depression
(per-presynaptic resource x ← x − 0.2x per spike, recovering with τ = 200 ms); and input scaling by
neuron size (per-synapse PSP weighted by w·c/s, where s is neuron volume relative to its region's
median).

Transmitter sign follows the predicted neurotransmitter: acetylcholine excitatory; GABA and glutamate
inhibitory; monoamines excitatory unless overridden. **Neurons with unknown transmitter receive sign
0** — no sign is invented, leaving ~1.5% of the graph functionally silent rather than guessed at.

Synaptic delivery is event-driven: only outgoing edges of neurons that actually fired are traversed.
Membrane update and threshold detection are dense over all 165,122 neurons, a deliberate trade for
vectorisability.

---

## 4. Architecture

### 4.1 Four clocks

| process | rate | per 1 ms tick |
|---|---|---|
| MuJoCo physics | 0.2 ms | 5 substeps |
| LIF brain | 0.5 ms | 2 steps |
| Sensory transduction and motor readout | 1 ms | 1 |
| Optic lobe (flyvis) | 20 ms | 1 in 20 |

The physics timestep is halved from flybody's 0.1 ms with no-slip iterations disabled, reported
in-source as preserving gait quality at half the cost.

### 4.2 Shared connectome, private state

The connectome is written once into a `SharedArrayBuffer` and read by every animal; each receives a
private block for dynamic state and its own MuJoCo world. **Adding an animal costs state, not another
copy of the graph** — the decision that makes multi-animal simulation tractable in a browser. It
requires cross-origin isolation (COOP/COEP).

Animals interact through kinematic proxies updated at 30 Hz, so physics cost scales linearly rather
than quadratically, at the price that no solver is authoritative over an inter-animal collision.

---

## 5. Sensorimotor wiring

Every channel terminates on identified neurons specified by a body map. Transduction functions are
documented approximations, not fitted models.

**Olfaction.** Odorants are glomerular activation patterns; concentration at each antenna comes from
Gaussian plumes with wind advection, converted by a Hill function, with 6 Hz spontaneous baseline.
Critically, a **divisive gain control** across the antennal lobe follows the presynaptic inhibition of
Olsen and Wilson (2008), so the glomerular pattern is preserved while total drive is bounded.

**Gustation.** Resolved by tastant and body location (labellum, taste pegs, tarsi), with sugar and
bitter sensitivity modulated by internal state.

**Mechanosensation.** Rapidly adapting bristles (τ ≈ 15 ms). **Reafference:** self-generated footfalls
are attenuated 85% by an efference copy from the stepping generator, following the principle
demonstrated for visual reafference by Kim et al. (2015).

**Vision.** 721 rays per eye along the measured flyvis viewing directions feed the optic-lobe model
at 50 Hz; its node activations drive the matching male-CNS optic-lobe neurons — **62,157 neuron–node
pairs, ~38% of the entire connectome**. The optic lobe is settled under uniform grey at construction
and stored as a resting reference, so neurons respond to deviations. LC10 is driven explicitly as the
visual channel into courtship (Ribeiro et al., 2018).

**Audition.** Courtship song reaches Johnston's organ (Kamikouchi et al., 2009; Yorozu et al., 2009).
Song is near-field particle velocity: intensity falls ~1/r², making it a signal over millimetres, and
bilateral difference emerges from geometry rather than being imposed. The ~250 Hz carrier is
unrepresentable at 1 ms, but the pulse train is not, and inter-pulse interval is the species cue
(Coen et al., 2014), so pulses are modelled at 10 ms within a 35 ms interval.

**Thermo- and hygrosensation.** Arista thermosensory neurons respond to floor temperature (Gallio et
al., 2011); hygrosensory neurons, which depend on distinct ionotropic receptors (Enjin et al., 2016;
Knecht et al., 2016), respond to a humidity field.

**Motor readout.** Descending mode uses identified descending neurons per the optogenetic dissections
of Cande et al. (2018), Bidaye et al. (2014) and Namiki et al. (2018); connectome mode drives mapped
leg muscles through their own motor neurons. The giant-fibre-to-TTMn **electrical** synapse — absent
from a chemical connectome — is added explicitly, consistent with von Reyn et al. (2014). Escape is
gated by efference copies so self-produced optic flow does not trigger spurious escape.

---

## 6. Mushroom-body plasticity

Associative memory in *Drosophila* is stored at the Kenyon cell → MBON synapse (Aso et al., 2014;
Hige et al., 2015; Modi et al., 2020). In this connectome that class comprises **44,042 of 10,511,038
edges (0.419%)**, of which **29,169** survive the minimum-synapse threshold with non-zero weight,
spanning **3,981 Kenyon cells and 97 MBONs** (4,064 KCs are annotated in total).

A per-animal plastic overlay on that slice costs **114 kB per animal, against ~40 MB to duplicate the
graph**. The shared connectome stays shared. The complete circuit is present: 340 dopaminergic
neurons and the 2 APL neurons that enforce sparse coding (Lin et al., 2014; Turner et al., 2008).

**Learning rule.** Depression, not potentiation, is the established direction (Hige et al., 2015;
Cohn et al., 2015). The rule is eligibility trace × dopamine: coincidence of a Kenyon cell's spike
trace with dopamine in its compartment depresses that synapse, recovering over ~120 s. Compartments
are derived from **connectivity, not type names** — a dopaminergic neuron teaches the synapses onto
the MBONs it innervates — covering 96 of 97 MBONs and 334 of 340 DANs.

**Phasic detection.** Dopaminergic neurons here are tonically active, so learning from absolute level
depresses indiscriminately. The rule detects a rise above a slow baseline:

```
popFast   300 ms smoothing of the summed DAN trace
popBase   8 s slow reference
popRel    (popFast − popBase) / popBase
gate      (popRel − phasicFloor) × phasicGain,   phasicFloor = 0.15
```

---

## 7. The teaching signal: a dataset problem misdiagnosed as a parameter problem

This section is the paper's central empirical contribution, and it began as a failure.

### 7.1 Learning did not occur, and the threshold was not why

Under punishment, no synapse changed. The obvious hypothesis — that `phasicFloor` was set too high —
was tested by lowering it to 0.05 and running an **unpunished control at the same setting**:

| condition (8 s, no punishment) | result |
|---|---|
| `popRel` median | 0 |
| `popRel` 90th percentile | 0.056 |
| `popRel` maximum | **0.108** |
| synapses depressed | **1,094** |

Unpunished `popRel` reaches 0.108; punished peaks at 0.111. **The distributions overlap almost
entirely.** Lowering the gate did not produce learning — it reproduced the indiscriminate depression
the floor exists to prevent. The default threshold is correctly placed just above resting noise.

> An earlier justification for lowering the threshold — that rest "sits at 0.002" — came from a single
> point sample rather than a distribution, and was wrong. A noise floor must be characterised by its
> distribution.

### 7.2 A second hypothesis, also wrong

The detector summed **all 340 dopaminergic neurons** and asked "is there more dopamine than usual" — a
question that cannot distinguish reward from punishment, since PPL1 signals punishment and PAM signals
reward (Aso et al., 2014). With **24 PPL against 316 PAM**, a genuine punishment burst is diluted
sevenfold. The detector was corrected to run on the PPL subset, which is right on its own terms but
**did not unblock learning**:

| stimulus | summed trace | PPL subset | change |
|---|---|---|---|
| baseline | 27.1 | 11.09 | — |
| hot floor (0.5) | 30.2 | 12.24 | +11% |
| bitter | 31.9 | 12.44 | +12% |

Against the ~68% rise the gate was designed around. Doubling the heat *lowered* the response (0.111 →
0.099) while costing the animal 35% of its health: **the nociceptive drive saturates**, so punishment
strength was never the lever.

### 7.3 The actual cause

Graph analysis, requiring no simulation:

```
thermosensory (25) → PPL (24)    0 direct edges,  103 two-hop paths via 46 intermediates
gustatory   (1428) → PPL (24)    0 direct edges,   89 two-hop paths via 49 intermediates
```

The 25 neurons annotated *thermosensory* are **arista cells**, which report preferred temperature
(Gallio et al., 2011). They are not nociceptors. Noxious heat and mechanical nociception in
*Drosophila* are carried by **class IV multidendritic neurons** (Tracey et al., 2003), which are
peripheral and therefore almost entirely outside a central-brain EM volume.

**The afferents that carry "this hurts" are not missing weight. They are missing from the dataset.**

### 7.4 Supplying the missing afferent

Noxious intensity (heat or bitter, through a Hill function) now drives the PPL1 cluster directly.
This is the same category of intervention as the giant-fibre → TTMn electrical synapse the model
already adds explicitly because a chemical connectome cannot contain it: a sensory channel the volume
does not cover, not a circuit being puppeted.

It is **off by default** (`?noci=1`), its constants are documented as chosen rather than fitted, and
any result depending on it must say so.

**Validated against its own control** — weights zeroed *after* settling, then undisturbed rest before
any punishment:

| phase | synapses depressed | `avRel` | gate |
|---|---|---|---|
| quiet rest | 0 | −0.020 | 0 |
| quiet rest | 0 | −0.028 | 0 |
| quiet rest | 0 | −0.021 | 0 |
| punished | 3,704 | 0.142 | 0.311 |
| punished | 4,068 | 0.109 | 0.239 |
| punished | 4,176 | 0.106 | 0.232 |

Health 1.00 throughout. **Zero at rest, 4,176 under punishment**, gate shut at rest and open under
heat. Contrast with §7.1, where lowering the threshold gave 1,094 depressed synapses with nothing
happening at all.

> The control resets the weights *after* settling for a reason: an earlier version reset before, and
> recorded 544 "resting" depressions that had accrued during the post-warm-up transient. Reset before
> settling and you measure your own startup.

### 7.5 A learned memory survives a reload

| stage | synapses | non-zero | checksum |
|---|---|---|---|
| naive | 29,169 | **0** | 0 |
| after 2.5 s simulated punishment | 29,169 | 3,887 | — |
| saved to store | 29,169 | **4,096** | 1833.1076 |
| *page reloaded* | | | |
| read from the **running worker** | 29,169 | **4,096** | 1821.4132 |

Same count, same indices. The checksum is 0.6% lower because the memory is *decaying*: the checksum
fell by 0.99362× and the maximum depression fell from 1.00000 to 0.99362 — **the same factor to five
decimals**, a uniform multiplicative decay across every edge, which is what a 120 s recovery constant
does in the fraction of a second between seeding and read-back. A corrupted or partially written
array would not decay uniformly.

**What this does and does not show.** It shows the machinery works: punishment-contingent synaptic
change that persists across sessions. It does **not** show that the fly's behaviour changes as a
result. That distinction should be preserved in any description of this work.

---

## 8. Coverage analysis

Neurons are *driven* if any transduction path writes firing rate to them, *read* if any motor path
reads their spike count, and *interior* otherwise.

| category | neurons | share |
|---|---|---|
| externally driven (sensory) | 74,498 | 45.1% |
| read as output (motor) | 534 | 0.3% |
| interior | 90,090 | 54.6% |

A 54.6% interior fraction is the appropriate figure: those neurons *should* be driven by the
connectome rather than by the simulation.

**Sensory coverage: 11,852 of 15,912 annotated sensory neurons (74.5%).** Vision, thermosensation,
olfaction, tactile mechanosensation and hygrosensation are essentially complete. The substantive gaps
are 1,144 unclassified mechanosensory afferents and **1,707 neurons annotated only as "unknown
sensory"**, which cannot be driven without knowing their modality.

**Output coverage is the more consequential gap:**

| population | total | read | gap |
|---|---|---|---|
| descending neurons | 1,314 | 69 | **1,245** |
| VNC motor neurons | 708 | 386 | 322 |
| CB motor neurons | 107 | 79 | 28 |
| efferent neurons | 110 | 0 | 110 |
| endocrine cells | 94 | 0 | 94 |
| enteric nervous system | 47 | 0 | 47 |

The motor layer reads ~18 named descending types against 1,314 descending neurons present. Three
whole systems — efferent, endocrine, enteric — are absent from the loop entirely.

---

## 9. Methodological results

Several findings concern *measuring* such a system, and cost more time than the experiments they
served.

### 9.1 Furnishing the arena makes it faster

Adding 31 obstacles was expected to cost throughput, since each becomes a collision geom in every
fly's world and is walked by the clearance computation each sensory tick. Measured across separate
page loads (obstacles compile into the physics model at fly creation, so an in-session A/B measures
nothing), with ~1% within-cell variance:

| | vision ON | vision OFF |
|---|---|---|
| 56 obstacles | **0.0302** | 0.0399 |
| 25 obstacles | **0.0177** | 0.0445 |
| | props 1.7× **faster** | props 10% slower |

With vision off, obstacles cost ~10% — the honest physics overhead. With vision on, the same
obstacles make the simulation **1.7× faster**. The mechanism is **ray termination**: each fly casts
1,442 rays per sample, and in an empty arena those run to the wall or to the cutoff, while in a
furnished one many hit a crate within millimetres. Ray casting dominates per-fly cost, so clutter
buys throughput. The flies actually travelled *further* with props, ruling out the alternative
explanation.

**An empty arena is the expensive case.** Benchmarks run in a bare ring overstate the cost of vision.

### 9.2 Throttling

A backgrounded browser tab runs the worker timers roughly **40× slower** (0.0366× actively polled
versus 0.0009× left alone, measured on one page minutes apart). Any unattended measurement through a
normal window is therefore suspect. Two harnesses address this: a headless page that removes
rendering entirely and flags any point measured while hidden as `DIRTY`, and a Node runner that
launches Chrome with background throttling disabled so a sweep can run unattended.

### 9.3 Check which device the benchmark ran on

On switchable-graphics hardware the browser may use the integrated GPU while the discrete GPU idles,
and `chrome://gpu` does not reveal this because it lists every adapter present. The embedded preview
pane used here reports adapter `intel`; the system Chrome reports `nvidia`, and one fly runs at
0.059× there against 0.0225× in the pane. Every benchmark now prints its adapter string.

---

## 10. A failed experiment: persistent defensive arousal

Anderson and Adolphs (2014) propose studying emotion in insects through measurable properties —
valence, persistence, scalability, generalisation — rather than through claims about feeling. Gibson
et al. (2015) applied this to *Drosophila*, reporting a defensive arousal after repeated looming that
outlasts the stimulus, scales with sweeps, raises locomotion and suppresses feeding.

A first attempt to reproduce this **failed, and was uninterpretable rather than merely negative**:

| condition | baseline speed | post +2 s | post +4 s |
|---|---|---|---|
| 0 passes (control) | 0.422 cm/s | 1.45 | 1.23 |
| 2 passes | 0.737 cm/s | 0.83 | 1.93 |
| 6 passes | 1.495 cm/s | 0.50 | 0.84 |

The control produced the largest immediate elevation. But the informative numbers are the baselines:
**0.422 → 0.737 → 1.495 cm/s**, rising monotonically in exactly the order the conditions ran. Four
faults:

1. **Order confounded with time** — conditions ran ascending on one animal with no washout.
   Normalising to each condition's own baseline makes this worse, since dividing by a climbing
   baseline manufactures a falling trend.
2. **n = 1**, while the unpunished control alone swung 1.45× spontaneously.
3. **Bins too short** — 2 s samples bout phase, not state.
4. **The stimulus was not a looming stimulus.** The threat animation runs on wall-clock time: a
   ~350 ms swoop, which at 0.04× real time is **13 ms of the fly's own time**.

The fourth is the most important, and generalises: **anything timed for the fly must be expressed in
simulated time.** Wall-clock animation is for the viewer.

> The 0-pass control is the only reason this was caught. Without it, a 1.45× post-stimulus elevation
> reads as textbook defensive arousal. Every behavioural measure in this system needs a no-stimulus
> control run in the same session.

A corrected design — randomised order, independent replicates, washout with baseline spread reported,
wider bins, and the loom expressed in simulated time — has been implemented and is reported separately.

---

## 11. Limitations

1. **No validation against behavioural data.** No gait, trajectory or response statistic has been
   compared quantitatively to recorded *Drosophila* behaviour.
2. **Transduction functions are plausible, not fitted.** Every gain and time constant in Section 5 was
   chosen for reasonable dynamics, not estimated from electrophysiology.
3. **Synaptic sign is predicted, not measured**, and ~1.5% of neurons have no assigned sign.
4. **The nociceptive afferent is an addition beyond the connectome.** It is off by default and
   justified in §7.3, but any learning result depends on it.
5. **Learning has no demonstrated behavioural consequence.** Synaptic change is measured; avoidance is
   not.
6. **No plasticity outside the mushroom body**, and no homeostatic regulation of the kind Marder and
   Goaillard (2006) show to be pervasive.
7. **Inter-animal physics is approximate** — conspecifics are kinematic proxies.
8. **Timescale.** The animal runs at roughly 0.02–0.06× real time depending on configuration, so
   experience is heavily compressed relative to a real fly's history.

---

## 12. Toward greater realism

Ordered by expected gain per unit effort.

1. **Close the descending gap.** 1,245 descending neurons are simulated but unread. Reading the full
   population as a distributed motor command is the single largest structural gap.
2. **Resolve the 1,707 unknown sensory annotations** against newer cell typing (Schlegel et al.,
   2024), converting a coverage gap into working channels.
3. **Interoception.** The enteric (47) and endocrine (94) populations are entirely outside the loop.
4. **Injury sensitisation.** Khuong et al. (2019) report persistent hypersensitivity after nerve
   injury in *Drosophila*. With nociception now present, this becomes implementable and would be the
   first mechanism here resembling a lasting aversive state.
5. **Behavioural validation** — optomotor response, odour-tracking statistics, grooming sequence
   structure (Seeds et al., 2014), courtship song timing. Until such comparisons exist, claims about
   realism remain architectural rather than empirical.

---

## 13. Conclusion

A complete insect connectome can be embedded in a physically simulated body and run in a closed
sensorimotor loop on consumer hardware, with every sensory and motor signal terminating on identified
neurons. Coverage is substantially complete on the sensory side (74.5%) and markedly incomplete on the
output side, where 1,245 of 1,314 descending neurons are simulated but unread.

The paper's central result is negative in origin and positive in outcome: **associative learning was
blocked not by a misconfigured parameter but by an absent afferent population**, invisible from inside
the simulation and diagnosable only by asking the graph a question it could answer directly. Two
plausible parameter-level explanations were tested and rejected first, one of which — lowering the
plasticity threshold — actively reproduced the pathology it was meant to cure, and was caught only by
an unpunished control.

The recurring methodological lesson is the same in every section: **the control is the experiment.**
The lowered threshold looked like learning until the unpunished condition was run; the arousal result
looked like defensive arousal until the zero-pass condition was run; the obstacle cost looked like a
GC artefact until the comparison was done across page loads. In a system with this many interacting
timescales, a result without its own control is not a weak result — it is not a result.

---

## References

Anderson, D. J., & Adolphs, R. (2014). A framework for studying emotions across species. *Cell, 157*(1), 187–200.

Aso, Y., Hattori, D., Yu, Y., Johnston, R. M., Iyer, N. A., Ngo, T.-T. B., Dionne, H., Abbott, L. F., Axel, R., Tanimoto, H., & Rubin, G. M. (2014). The neuronal architecture of the mushroom body provides a logic for associative learning. *eLife, 3*, e04577.

Bargmann, C. I., & Marder, E. (2013). From the connectome to brain function. *Nature Methods, 10*(6), 483–490.

Bateson, M., Desire, S., Gartside, S. E., & Wright, G. A. (2011). Agitated honeybees exhibit pessimistic cognitive biases. *Current Biology, 21*(12), 1070–1073.

Bidaye, S. S., Machacek, C., Wu, Y., & Dickson, B. J. (2014). Neuronal control of *Drosophila* walking direction. *Science, 344*(6179), 97–101.

Cande, J., Namiki, S., Qiu, J., Korff, W., Card, G. M., Shaevitz, J. W., Stern, D. L., & Berman, G. J. (2018). Optogenetic dissection of descending behavioral control in *Drosophila*. *eLife, 7*, e34275.

Coen, P., Clemens, J., Weinstein, A. J., Pacheco, D. A., Deng, Y., & Murthy, M. (2014). Dynamic sensory cues shape song structure in *Drosophila*. *Nature, 507*(7491), 233–237.

Cohn, R., Morantte, I., & Ruta, V. (2015). Coordinated and compartmentalized neuromodulation shapes sensory processing in *Drosophila*. *Cell, 163*(7), 1742–1755.

Dorkenwald, S., Matsliah, A., Sterling, A. R., Schlegel, P., Yu, S.-C., McKellar, C. E., Lin, A., Costa, M., Eichler, K., Yin, Y., Silversmith, W., Murthy, M., & Seung, H. S. (2024). Neuronal wiring diagram of an adult brain. *Nature, 634*, 124–138.

Enjin, A., Zaharieva, E. E., Frank, D. D., Mansourian, S., Suh, G. S. B., Gallio, M., & Stensmyr, M. C. (2016). Humidity sensing in *Drosophila*. *Current Biology, 26*(10), 1352–1358.

Gallio, M., Ofstad, T. A., Macpherson, L. J., Wang, J. W., & Zuker, C. S. (2011). The coding of temperature in the *Drosophila* brain. *Cell, 144*(4), 614–624.

Gibson, W. T., Gonzalez, C. R., Fernandez, C., Ramasamy, L., Tabachnik, T., Du, R. R., Felsen, P. D., Maire, M. R., Perona, P., & Anderson, D. J. (2015). Behavioral responses to a repetitive visual threat stimulus express a persistent state of defensive arousal in *Drosophila*. *Current Biology, 25*(11), 1401–1415.

Hige, T., Aso, Y., Modi, M. N., Rubin, G. M., & Turner, G. C. (2015). Heterosynaptic plasticity underlies aversive olfactory learning in *Drosophila*. *Neuron, 88*(5), 985–998.

Ito, K., Shinomiya, K., Ito, M., Armstrong, J. D., Boyan, G., Hartenstein, V., Harzsch, S., Heisenberg, M., Homberg, U., Jenett, A., Keshishian, H., Restifo, L. L., Rössler, W., Simpson, J. H., Strausfeld, N. J., Strauss, R., & Vosshall, L. B. (2014). A systematic nomenclature for the insect brain. *Neuron, 81*(4), 755–765.

Kamikouchi, A., Inagaki, H. K., Effertz, T., Hendrich, O., Fiala, A., Göpfert, M. C., & Ito, K. (2009). The neural basis of *Drosophila* gravity-sensing and hearing. *Nature, 458*(7235), 165–171.

Khuong, T. M., Wang, Q.-P., Manion, J., Oyston, L. J., Lau, M.-T., Towler, H., Lin, Y. Q., & Neely, G. G. (2019). Nerve injury drives a heightened state of vigilance and neuropathic sensitization in *Drosophila*. *Science Advances, 5*(7), eaaw4099.

Kim, A. J., Fitzgerald, J. K., & Maimon, G. (2015). Cellular evidence for efference copy in *Drosophila* visuomotor processing. *Nature Neuroscience, 18*(9), 1247–1255.

Knecht, Z. A., Silbering, A. F., Ni, L., Klein, M., Budelli, G., Bell, R., Abuin, L., Ferrer, A. J., Samuel, A. D. T., Benton, R., & Garrity, P. A. (2016). Distinct combinations of variant ionotropic glutamate receptors mediate thermosensation and hygrosensation in *Drosophila*. *eLife, 5*, e17879.

Lappalainen, J. K., Tschopp, F. D., Prakhya, S., McGill, M., Nern, A., Shinomiya, K., Takemura, S., Gruntman, E., Macke, J. H., & Turaga, S. C. (2024). Connectome-constrained networks predict neural activity across the fly visual system. *Nature, 634*, 1132–1140.

Lin, A. C., Bygrave, A. M., de Calignon, A., Lee, T., & Miesenböck, G. (2014). Sparse, decorrelated odor coding in the mushroom body enhances learned odor discrimination. *Nature Neuroscience, 17*(4), 559–568.

Marder, E., & Goaillard, J.-M. (2006). Variability, compensation and homeostasis in neuron and network function. *Nature Reviews Neuroscience, 7*(7), 563–574.

Modi, M. N., Shuai, Y., & Turner, G. C. (2020). The *Drosophila* mushroom body: From architecture to algorithm in a learning circuit. *Annual Review of Neuroscience, 43*, 465–484.

Namiki, S., Dickinson, M. H., Wong, A. M., Korff, W., & Card, G. M. (2018). The functional organization of descending sensory-motor pathways in *Drosophila*. *eLife, 7*, e34272.

Olsen, S. R., & Wilson, R. I. (2008). Lateral presynaptic inhibition mediates gain control in an olfactory circuit. *Nature, 452*(7190), 956–960.

Ribeiro, I. M. A., Drews, M., Bahl, A., Machacek, C., Borst, A., & Dickson, B. J. (2018). Visual projection neurons mediating directed courtship in *Drosophila*. *Cell, 174*(3), 607–621.

Scheffer, L. K., Xu, C. S., Januszewski, M., Lu, Z., Takemura, S., Hayworth, K. J., Huang, G. B., Shinomiya, K., Maitlin-Shepard, J., Berg, S., Hess, H. F., & Plaza, S. M. (2020). A connectome and analysis of the adult *Drosophila* central brain. *eLife, 9*, e57443.

Schlegel, P., Yin, Y., Bates, A. S., Dorkenwald, S., Eichler, K., Brooks, P., Han, D. S., Gkantia, M., dos Santos, M., Munnelly, E. J., Murthy, M., & Jefferis, G. S. X. E. (2024). Whole-brain annotation and multi-connectome cell typing of *Drosophila*. *Nature, 634*, 139–152.

Seeds, A. M., Ravbar, P., Chung, P., Hampel, S., Midgley, F. M., Mensh, B. D., & Simpson, J. H. (2014). A suppression hierarchy among competing motor programs drives sequential grooming in *Drosophila*. *eLife, 3*, e02951.

Shiu, P. K., Sterne, G. R., Spiller, N., Franconville, R., Sandoval, A., Zhou, J., Simha, N., Kang, C. H., Yu, S., Kim, J. S., Dorkenwald, S., & Scott, K. (2024). A leaky integrate-and-fire computational model based on the connectome of the entire adult *Drosophila* brain reveals insights into sensorimotor processing. *Nature, 634*, 210–219.

Todorov, E., Erez, T., & Tassa, Y. (2012). MuJoCo: A physics engine for model-based control. In *2012 IEEE/RSJ International Conference on Intelligent Robots and Systems* (pp. 5026–5033). IEEE.

Tracey, W. D., Wilson, R. I., Laurent, G., & Benzer, S. (2003). *painless*, a *Drosophila* gene essential for nociception. *Cell, 113*(2), 261–273.

Turner, G. C., Bazhenov, M., & Laurent, G. (2008). Olfactory representations by *Drosophila* mushroom body neurons. *Journal of Neurophysiology, 99*(2), 734–746.

Vaxenburg, R., Siwanowicz, I., Merel, J., Robie, A. A., Morrow, C., Novati, G., Stefanidi, Z., Card, G. M., Reiser, M. B., Botvinick, M. M., Branson, K., Tassa, Y., & Turaga, S. C. (2024). Whole-body physics simulation of fruit fly locomotion. *bioRxiv*.

von Reyn, C. R., Breads, P., Peek, M. Y., Zheng, G. Z., Williamson, W. R., Yee, A. L., Leonardo, A., & Card, G. M. (2014). A spike-timing mechanism for action selection. *Nature Neuroscience, 17*(7), 962–970.

Yorozu, S., Wong, A., Fischer, B. J., Dankert, H., Kernan, M. J., Kamikouchi, A., Ito, K., & Anderson, D. J. (2009). Distinct sensory representations of wind and near-field sound in the *Drosophila* brain. *Nature, 458*(7235), 201–205.

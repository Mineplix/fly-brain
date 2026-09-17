// Endogenous activity: the part of behaviour that comes from inside the fly rather than from its senses.
// The connectome model has no neuromodulation and no intrinsic dynamics, so left alone it only reacts: it
// either never starts walking or, once walking, never stops. Real flies in a featureless arena alternate
// walking bouts, pauses and grooming with heavy-tailed durations, and turn in brief saccades whose timing
// is neither random nor stimulus-locked (Maye et al. 2007, PLoS ONE 2:e443; Brembs 2011, Proc R Soc B
// 278:930 on spontaneous variability as the biological basis of "free will"; Geurten et al. 2014 on
// saccadic walking). This module stands in for those unmodelled central inputs (octopaminergic arousal,
// action selection): it delivers slowly varying excitatory synaptic input to identified descending neurons.
// It is a conductance, not a current, because the embodied brain holds these DNs in a high-conductance
// state (inhibition ~3x the leak) where an injected current is shunted.
// The connectome still integrates this drive with sensory input, so inhibition (sugar stop, bitter,
// contact) can still veto it, and every command leaves the brain through the usual DN readout.
import { DN_ROLES } from './motor.js';
const TYPES = { fwd: ['DNg100', 'DNg97'], turn: ['DNa02', 'DNa01'], groom: ['DNg07', 'DNg08', 'DNg12'], back: ['MDN'], brake: Object.keys(DN_ROLES.forward), takeoff: Object.keys(DN_ROLES.takeoff) };
export const INTRINSIC = {
  walkBout: [2.2, 0.9],     // lognormal bout durations: median s, log-sd
  stopBout: [1.4, 0.9],
  groomBout: [2.5, 0.4], pGroom: 0.2,   // chance a pause is spent grooming
  // excitatory conductance added per ms (steady-state gE ~5.5x this; units of the LIF kernel)
  fwdDrive: 12, fwdJitter: 0.25, fwdTau: 800,   // forward DNs while walking; slow OU speed variation (fraction)
  saccadeRate: 0.7, standSaccadeRate: 0.3, saccadeMs: [120, 260], turnDrive: 10,   // spontaneous body saccades
  groomDrive: 10,
  stopBrake: 6, feedBrake: 16, feedDrive: 10,   // inhibitory conductance on all forward DNs: flies stop actively, firmly on food
  avoidMs: 350, backDrive: 14,   // head-on contact: back off this long, then turn away
  // Refractory and escalation for wall avoidance. Every other avoidance case had a refractory --
  // graze 400 ms, heat 700 ms, and the flight path uses lastAvoid -- while the walking head-on
  // case had none. An animal still touching the wall when an episode cleared re-entered on the
  // next step, so it backed up and turned in place indefinitely. Measured 2026-09-15: a fly
  // circling the perimeter spent 44 of 50 samples in `avoiding`, which read as standing still.
  // The escalation matters as much as the refractory: repeating the same 500-900 ms turn against
  // the same wall reproduces the same failure, so a chained episode turns progressively further,
  // which is also what a fly in a corner does.
  avoidRefractory: 600, avoidChainMs: 2500, avoidChainTurn: 0.6, avoidChainMax: 3,
  grazeTurnMs: [120, 260], grazeRefractory: 400,   // one-sided contact: turn away without stopping
  heatRefractory: 700,
  // Escape by air from a uniformly burning substrate. burnEscape is below the 0.35 tarsal
  // damage threshold so the animal leaves before it is badly hurt rather than after.
  // burnFlyEarliest must clear READOUT.startupMs in motor.js (1500 ms), or the request is
  // issued into a window where jumps are refused and is silently lost.
  burnEscape: 0.28, burnFlyRefractory: 1200, burnFlyEarliest: 1700,
  feedBout: [6, 0.5], satiety: 0.9, searchMs: 12000, searchTurns: 3,   // feeding stop, then local search
  pTakeoff: 0.1, pTakeoffWall: 0.1, takeoffDrive: 20,   // chance a bout ends in a voluntary takeoff (more when hungry), via DNp02/DNp04
  flightSaccadeRate: 1.0, flightSaccadeMs: [80, 160], avoidAhead: 0.4, avoidDrive: 18,   // flight: avoid when the path 9 mm ahead (FlyAgent.state) comes within 4 mm of a surface
  // courtship: the connectome's pIP10 + DNp13 rate (ctx.court.level, see motor.js) tells the male a fly is
  // near; he chases it by steering on its bearing and sings with the wing on its side (Ewing & Bennet-Clark 1968)
  courtEnter: 0.4, courtExit: 0.2, courtRange: 1.8, courtLostMs: 1500, courtSing: 0.45, courtDrive: 9, courtTurn: 12,
};
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export class Intrinsic {
  constructor(typeOf, sideOf, seed = 1, feeding = []) {
    const pick = (types, s) => { const o = []; for (let i = 0; i < typeOf.length; i++) if (types.includes(typeOf[i]) && (s === undefined || sideOf[i] === s)) o.push(i); return o; };
    this.ix = { feed: [...new Set([...pick(['MN9']), ...feeding])], takeoff: pick(TYPES.takeoff), brake: pick(TYPES.brake), fwd: pick(TYPES.fwd), turnL: pick(TYPES.turn, 1), turnR: pick(TYPES.turn, 2), groom: pick(TYPES.groom), back: pick(TYPES.back) };
    this.rand = mulberry(seed * 7919 + 17);
    this.state = 'stop'; this.left = 300 + 700 * this.rand();   // settle briefly before the first decision
    this.fwdNoise = 0; this.sacc = null; this.sinceSacc = 0; this.avoid = null; this.t = 0; this.touchL = this.touchR = this.lastGraze = this.lastHeat = this.leftFood = this.lastAvoid = this.lastSugar = -1e9; this.avoidDir = 1; this.lastWallAvoid = -1e9; this.wallChain = 0; this.lastBurnFly = -1e9; this.searchUntil = 0; this.hot = 0; this.approach = false; this.lastDir = this.rand() < 0.5 ? 1 : -1;
    this.bias = { fwd: 0, turnL: 0, turnR: 0, groom: 0, back: 0, takeoff: 0, feed: 0 }; this.takeoffUntil = -1; this.urgentUntil = -1;
  }
  gauss() { let u = 0; while (!u) u = this.rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rand()); }
  lognormal([median, sd]) { return 1000 * median * Math.exp(sd * this.gauss()); }
  /** one ms. ctx: { energy 0..1, touch/heat: {left, right} per antenna, rearing: body pitched up against something } */
  update(dtMs, brain, ctx) {
    // hunger gates feeding. Starved flies also walk more (Yang et al. 2015): with neuromodulation that comes from
    // the octopamine level of the AKH-sensitive OA neurons (ctx.arousal, see neuromod.js), otherwise from energy
    const P = INTRINSIC, hunger = Math.max(0, Math.min(1, (0.7 - ctx.energy) / 0.6)), arousal = ctx.arousal ?? hunger;
    // obstacle at the front. Head-on (both antennae within 150 ms, or the body rearing up against it): stop,
    // back off, pivot away, walk on. One antenna grazing: turn away while walking, which is how flies come to
    // follow walls.
    const t = this.t += dtMs;
    if (ctx.flying) return this.flightUpdate(t, dtMs, brain, ctx);
    if (this.state === 'fly') { this.state = 'stop'; this.left = 500 + 1000 * this.rand(); this.sacc = null; }   // landed
    if (ctx.touch.left) this.touchL = t; if (ctx.touch.right) this.touchR = t;
    // courtship gating: the pheromone-driven courtship readout (pIP10, DNp13) must be high, another fly must
    // be in range, and no avoidance in progress. While courting, contact with the other fly is not an obstacle.
    const courting = this.state === 'court';
    const court = ctx.court;
    if (!this.courting && court && court.level > P.courtEnter && court.dist < P.courtRange && !this.avoid && this.state !== 'feed') { this.courting = { lost: 0 }; this.sacc = null; this.state = 'court'; }
    if (this.courting) {
      if (!court || court.level < P.courtExit || court.dist > P.courtRange * 1.5 || this.avoid) {
        if ((this.courting.lost += dtMs) > P.courtLostMs) { this.courting = null; this.courtSing = false; if (this.state === 'court') { this.state = 'stop'; this.left = 400 + 600 * this.rand(); } }
      } else this.courting.lost = 0;
    }
    const headOn = ctx.rearing || (t - this.touchL < 150 && t - this.touchR < 150);
    const graze = ctx.touch.left !== ctx.touch.right;
    if (!courting && !this.avoid && headOn && t - this.lastWallAvoid > P.avoidRefractory) {
      // A new episode soon after the last one means the turn did not clear the obstacle. Turn
      // further each time rather than repeating a manoeuvre that has already failed.
      this.wallChain = (t - this.lastWallAvoid < P.avoidChainMs) ? Math.min(P.avoidChainMax, this.wallChain + 1) : 0;
      const esc = 1 + P.avoidChainTurn * this.wallChain;
      this.avoid = { t: 0, dir: this.touchL > this.touchR ? -1 : this.touchR > this.touchL ? 1 : (this.rand() < 0.5 ? 1 : -1), turn: (500 + 400 * this.rand()) * esc, why: ctx.rearing ? 'rear' : 'both' };
      // After repeated failures, commit to one direction instead of re-rolling it each time.
      if (this.wallChain >= 2) this.avoid.dir = this.avoidDir;
      else this.avoidDir = this.avoid.dir;
      this.sacc = null;
      this.avoid.fly = this.rand() < P.pTakeoffWall;   // or leave the wall by air, once turned away from it
    } else if (!courting && !this.avoid && graze && t - this.lastGraze > P.grazeRefractory) {
      const dir = ctx.touch.left ? -1 : 1;   // +1 = turn left
      this.sacc = { t: 0, dur: P.grazeTurnMs[0] + (P.grazeTurnMs[1] - P.grazeTurnMs[0]) * this.rand(), dir }; this.lastDir = dir; this.sinceSacc = 0; this.lastGraze = t;
    }
    // noxious heat at the aristae: turn away from the warmer side and run (flies turn back at a hot edge). Deep
    // inside a hot patch (after landing on it) both sides read the same saturated heat, so turning has no
    // direction to go: run straight out instead of turning on the spot
    const hot = Math.max(ctx.heat.left, ctx.heat.right); this.hot = hot;
    if (hot > 0.08 && !this.avoid && t - this.lastHeat > P.heatRefractory) {
      const even = Math.abs(ctx.heat.left - ctx.heat.right) < 0.02, dir = even ? this.lastDir : ctx.heat.left > ctx.heat.right ? -1 : 1;
      if (!(even && hot > 0.9)) { this.sacc = { t: 0, dur: 300 + 300 * this.rand(), dir }; this.lastDir = dir; this.sinceSacc = 0; }
      this.lastHeat = t; this.state = 'walk'; this.left = Math.max(this.left, 1500);
    }
    // ESCAPE BY AIR. The block above turns away from heat and runs, which is the right response to
    // a hot PATCH. It is useless on a floor that is uniformly molten: both antennae read the same
    // value, there is no gradient to descend, and the animal walks about on the hazard until it
    // dies. Flies burned on a uniformly hot surface leave it, and the only way off this one is up.
    //
    // Gated on TARSAL heat, not antennal: the feet are what touch the substrate, the antennae sit
    // a body-height above it, and the burn threshold in fly.js is a tarsal quantity. Requiring a
    // flat gradient as well means a hot patch is still handled by walking, which is cheaper and is
    // what a real fly does when there is somewhere cooler to stand.
    //
    // This is hand-supplied, like everything else in this module. The connectome has no path from
    // a burning tarsus to a takeoff command -- the takeoff descending neurons it reads (DNp01,
    // DNp02, DNp04, DNp06, DNp10) are looming-visual cells -- so an escape reflex here is a stand-in
    // for a pathway the model does not contain, not a result produced by one.
    // RE-ARM WHILE BURNING, and not before the motor layer will accept a jump. The first version
    // fired once, at t = 18 ms, triggered by the arena's default hot patch before any experiment
    // had begun -- inside the 1500 ms startup window during which motor.js refuses all jumps. The
    // 80 ms takeoff request expired unheard, the refractory then suppressed every retry, and an
    // animal stood burning on a molten floor with its escape reflex already spent. A reflex that
    // can be consumed without being acted on is worse than none, because it reports as present.
    const feet = ctx.heatFeet || 0;
    const flat = Math.abs(ctx.heat.left - ctx.heat.right) < 0.03;
    // UPRIGHT, or the request is refused and wasted. motor.js gates every jump on
    // (up > 0.5 && !righting && !flying): an inverted fly cannot launch, which is correct, since a
    // real one cannot either. The first version of this reflex did not check, so a fly that had
    // landed on its back went on issuing takeoff requests that were refused, consuming the 1200 ms
    // refractory each time while it burned. Observed as an animal flopping on molten ground
    // instead of leaving it. While inverted the right behaviour is to right itself, which the
    // righting reflex in motor.js already does, so the escape reflex simply holds its turn.
    const upright = (ctx.up ?? 1) > 0.5;
    const canAct = t > P.burnFlyEarliest && upright;   // past the startup lockout, and able to jump
    if (feet > P.burnEscape && flat && canAct && t - this.lastBurnFly > P.burnFlyRefractory) {
      this.lastBurnFly = t;
      this.takeoffUntil = t + 160;                 // wider than the old 80 ms, which was one frame
      // URGENT: a takeoff that overrides the contact gate in motor.js. That gate refuses to launch
      // an animal whose antennae or body are against something, on the reasoning that a wall
      // filling the eye is not an approaching predator. It is right for looming and wrong here.
      // Making the scenery solid (the collision filters never matched before 2026-09-15, so props
      // were walk-through) turned contact from rare into constant, and a burning fly standing
      // anywhere near furniture could not leave the floor however hot it got. Measured: in an
      // empty arena the escape fires and the animal flies to 0.78 cm; among props it walks on the
      // lava until it dies. A fly on a hot surface tries to leave whether or not it is touching
      // something -- that is the whole point of the reflex.
      this.urgentUntil = t + 400;
      this.state = 'walk'; this.left = Math.max(this.left, 1200);
    }
    // food: a hungry fly that tastes sugar with its legs or labellum stops there to feed; once it leaves (sated,
    // or the bout ends), it searches locally with frequent turns, looping back to the spot (Dethier 1957,
    // Kim & Dickinson 2017)
    this.approach = ctx.sugar > 0.1 && ctx.energy < P.satiety && !ctx.mouthOnFood && this.state !== 'feed';   // sugar underfoot: step onto it
    if (ctx.sugar > 0.1 && ctx.mouthOnFood && ctx.energy < P.satiety && !this.avoid && this.state !== 'feed' && t - this.leftFood > 3000) {
      this.state = 'feed'; this.left = this.lognormal(P.feedBout) * (0.5 + 2 * hunger); this.sacc = null;
    }
    if (ctx.sugar > 0.1) this.lastSugar = t;
    if (this.state === 'feed' && (t - this.lastSugar > 400 || !ctx.mouthOnFood || ctx.energy >= P.satiety)) this.left = 0;   // off the food (feet lift and land, so allow gaps), or sated
    if (this.state === 'feed' && this.left - dtMs <= 0) { this.leftFood = t; this.searchUntil = t + P.searchMs; }
    const searching = t < this.searchUntil && this.state !== 'feed';
    if (this.avoid) {
      const a = this.avoid; a.t += dtMs;
      if (a.t > P.avoidMs && !this.sacc) this.sacc = { t: 0, dur: a.turn, dir: a.dir };   // pivot away
      if (a.t > P.avoidMs + a.turn) { if (a.fly) this.takeoffUntil = t + 80; this.avoid = null; this.lastWallAvoid = t; this.lastDir = a.dir; this.sinceSacc = 0; this.state = 'walk'; this.left = Math.max(this.left, 1000); }
    } else if (this.state === 'court' && court) {
      // chasing: no spontaneous saccades or bout transitions; steering is set from the target's bearing below
      const b = court.bearing;   // rad; >0 = target to the left
      this.courtSing = court.dist < P.courtSing && Math.abs(b) < 0.9;
      this.courtSide = b > 0 ? 'left' : 'right';
      this.sinceSacc = 0;
    } else {
      this.left -= dtMs;
      if (this.left <= 0) {   // action selection at the end of a bout
        if (this.approach && this.state !== 'feed') { this.state = 'walk'; this.left = 600; } else
        if (this.state !== 'feed' && this.state !== 'groom' && this.rand() < P.pTakeoff * (1 + 2 * arousal)) this.takeoffUntil = t + 80;   // leave by air
        if (this.state === 'feed') { this.state = 'walk'; this.left = this.lognormal(P.walkBout); }
        else if (this.state === 'walk') { this.state = this.rand() < P.pGroom * (1 - arousal) ? 'groom' : 'stop'; this.left = this.lognormal(this.state === 'groom' ? P.groomBout : P.stopBout) * (1 - 0.6 * arousal); }
        else { this.state = 'walk'; this.left = this.lognormal(P.walkBout) * (1 + 1.5 * arousal); }
      }
      // spontaneous saccades; alternate direction more often than not (flies avoid circling)
      this.sinceSacc += dtMs;
      const rate = (this.state === 'walk' ? P.saccadeRate * (searching ? P.searchTurns : 1) : this.state === 'stop' ? P.standSaccadeRate : 0) / 1000;
      if (!this.sacc && this.sinceSacc > 250 && this.rand() < rate * dtMs) {
        const dir = this.rand() < (searching ? 0.25 : 0.65) ? -this.lastDir : this.lastDir; this.lastDir = dir;   // searching: keep turning one way, looping
        this.sacc = { t: 0, dur: P.saccadeMs[0] + (P.saccadeMs[1] - P.saccadeMs[0]) * this.rand(), dir }; this.sinceSacc = 0;
      }
    }
    if (this.sacc && (this.sacc.t += dtMs) > this.sacc.dur) this.sacc = null;
    this.fwdNoise += dtMs / P.fwdTau * (-this.fwdNoise) + Math.sqrt(2 * dtMs / P.fwdTau) * this.gauss();
    const walking = this.state === 'walk' && !this.avoid;
    const B = this.bias;
    B.fwd = walking ? P.fwdDrive * (this.approach ? 0.7 : Math.max(0.3, 1 + P.fwdJitter * this.fwdNoise + 0.25 * arousal + 0.6 * this.hot)) : 0;
    B.back = this.avoid && this.avoid.t < P.avoidMs ? P.backDrive : 0;
    B.groom = this.state === 'groom' && !this.avoid ? P.groomDrive : 0;
    B.turnL = this.sacc && this.sacc.dir > 0 ? P.turnDrive : 0; B.turnR = this.sacc && this.sacc.dir < 0 ? P.turnDrive : 0;
    if (this.state === 'court' && court) {
      // chase: steer onto the target's bearing; close to singing distance, then keep station and extend
      // the wing facing her. Males keep walking while singing (Ewing & Bennet-Clark 1968).
      const b = court.bearing;
      B.turnL = b > 0.04 ? P.courtTurn * Math.min(1, b) : 0; B.turnR = b < -0.04 ? P.courtTurn * Math.min(1, -b) : 0;
      B.fwd = court.dist > 0.6 ? P.courtDrive : court.dist > 0.4 ? P.courtDrive * 0.4 : P.courtDrive * 0.15;
    }
    B.takeoff = t < this.takeoffUntil ? P.takeoffDrive : 0;
    // hunger gates the proboscis extension reflex: a hungry fly tasting sugar extends and pumps (MN9, pump MNs)
    B.feed = this.state === 'feed' ? P.feedDrive * (0.4 + hunger) : 0;
    for (const k in B) if (B[k] > 0) brain.pulse(this.ix[k], B[k] * dtMs);
    const brake = this.state === 'feed' ? P.feedBrake : this.state === 'stop' || this.state === 'groom' ? P.stopBrake : 0;
    if (brake) for (const i of this.ix.brake) brain.addG(i, 0, -brake * dtMs);
  }
  /** in flight: spontaneous saccades, and collision-avoidance saccades toward open space when a wall or block
   *  lies ahead (flies turn away from the side of visual expansion; Tammero & Dickinson 2002). ctx.ahead gives
   *  clearance (cm) at the lookahead point straight ahead and 40 degrees to each side. */
  flightUpdate(t, dtMs, brain, ctx) {
    const P = INTRINSIC, a = ctx.ahead;
    if (this.state !== 'fly') { this.state = 'fly'; this.sacc = null; this.avoid = null; this.lastDir = this.rand() < 0.5 ? 1 : -1; }
    this.sinceSacc += dtMs;
    if (a && a.center < P.avoidAhead && (!this.sacc || !this.sacc.strong)) {
      // commit to one direction until the way ahead is clear, or the fly dithers in front of the wall
      const dir = t - this.lastAvoid < 400 ? this.avoidDir : Math.abs(a.left - a.right) < 0.05 ? this.lastDir : a.left > a.right ? 1 : -1;
      this.sacc = { t: 0, dur: 150 + 100 * this.rand(), dir, strong: true }; this.lastDir = this.avoidDir = dir; this.sinceSacc = 0;
    }
    if (this.sacc?.strong && a && a.center < P.avoidAhead) this.lastAvoid = t;
    if (!this.sacc && this.sinceSacc > 200 && this.rand() < P.flightSaccadeRate / 1000 * dtMs) {
      const dir = this.rand() < 0.6 ? -this.lastDir : this.lastDir; this.lastDir = dir;
      this.sacc = { t: 0, dur: P.flightSaccadeMs[0] + (P.flightSaccadeMs[1] - P.flightSaccadeMs[0]) * this.rand(), dir }; this.sinceSacc = 0;
    }
    if (this.sacc && (this.sacc.t += dtMs) > this.sacc.dur) this.sacc = null;
    const drive = this.sacc ? (this.sacc.strong ? P.avoidDrive : P.turnDrive) : 0;
    if (drive) brain.pulse(this.sacc.dir > 0 ? this.ix.turnL : this.ix.turnR, drive * dtMs);
  }
  label() { return this.avoid ? 'avoiding' : this.state === 'walk' && this.t < this.searchUntil ? 'search' : this.state; }
}

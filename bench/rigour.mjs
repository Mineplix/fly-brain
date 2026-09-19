// RIGOUR: guards that make a measurement fail loudly instead of returning something answer-shaped.
//
// Every wrong result this project has produced had the same character: a number that could not fail
// loudly. Not a crash, not an obviously silly value -- a confident, plausible, wrong answer. The nine
// caught in one day fall into five patterns, and each guard below exists for named instances of one.
//
//   A. THE MEASUREMENT WASN'T OF THE REAL THING
//      The profiler re-implemented an abbreviated simulation step and timed that: 2.0 ms against a
//      real 28.4. A probe reported "verified with panels enabled" while its own URL hardcoded
//      nopanels.                                                  -> confirmConfig, measuringReal
//
//   B. THE BUFFER OR INDEX WAS WRONG, AND THE VALUES STILL PARSED
//      Weights read as 1.4e-38 (denormal floats: integers read as floats). A sign array with zero
//      negative entries across 165,122 neurons, so every edge classified as excitatory. Body spread
//      measured against a prop parked at z = -20, reporting a 0.25 cm fly as 20 cm across.
//                                                                 -> assertPopulated, assertPlausible
//
//   C. THE SUBJECT WASN'T IN A STATE WHERE THE QUESTION APPLIED
//      Behaviour measured in animals lying upside down, twice. Means taken over animals that were
//      dead. Two runs stalled for hours because a dead animal's clock never advances and every wait
//      burned its full timeout.                                   -> requireLive, requirePrecondition
//
//   D. THE SAMPLING WAS ALIASED WITH THE THING BEING SAMPLED
//      Sampled every 50th step to detect change; the stimulus refreshed every 10. Every sample
//      landed on a refresh, and 84% of values "changed".           -> assertNotAliased
//
//   E. THE VERDICT WAS DECIDED BY A THRESHOLD THAT NOISE PASSES
//      "The drive DOES scale" printed from 117.7, 0.2, 111.0, 4.9 because the test was
//      max > min * 1.3. Elsewhere, a real effect and the between-run spread were +2.39 and +2.36.
//                                                                 -> noiseFloor, verdict
//
// None of this is clever. It is the set of checks that would have caught each failure, written down
// so the next probe gets them for free instead of rediscovering them.

const NL = String.fromCharCode(10);
const say = (...a) => process.stdout.write(a.join(' ') + NL);

export class MeasurementError extends Error {}

/** Throw, rather than warn. A warning in a 400-line log is a thing nobody reads. */
function fail(msg) { throw new MeasurementError(msg); }

// ---- A. is this a measurement of the real thing? ------------------------------------------------

/**
 * Confirm the page is running the configuration the probe claims.
 *
 * A probe once reported smoothness "verified with panels up" while `nopanels=1` was hardcoded in its
 * own goto(). The claim was in the log text; the truth was in the URL, and nothing compared them.
 *
 * @param actualUrl  what the page actually loaded (read back from the page, not from a constant)
 * @param expect     { has: [...flags that must be present], lacks: [...that must not be] }
 */
export function confirmConfig(actualUrl, expect = {}) {
  const u = String(actualUrl);
  for (const f of expect.has || []) if (!u.includes(f)) fail(`config: expected "${f}" in the page URL, got ${u}`);
  for (const f of expect.lacks || []) if (u.includes(f)) fail(`config: "${f}" is in the page URL but this measurement claims otherwise -- ${u}`);
  return true;
}

/**
 * Confirm a setting actually applied, by reading it back from the system rather than assuming the
 * message arrived. A parameter that silently failed to apply produces a perfect null, and a perfect
 * null is indistinguishable from a real one.
 */
export function confirmApplied(reported, expected, name) {
  const r = JSON.stringify(reported), e = JSON.stringify(expected);
  if (r !== e) fail(`setting "${name}" did not apply: asked for ${e}, system reports ${r}`);
  return true;
}

// ---- B. do the numbers underneath make sense? ---------------------------------------------------

/**
 * A buffer of zeros passes almost any test written about it, and an array read at the wrong offset
 * usually still parses. Check the data before trusting a statistic derived from it.
 */
export function assertPopulated(arr, name, { minNonZeroFrac = 0.5, expectSomeNegative = false } = {}) {
  const n = Math.min(arr.length, 200000);
  let nz = 0, neg = 0, denorm = 0;
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (v !== 0) nz++;
    if (v < 0) neg++;
    // denormals (|v| < ~1e-37) are the signature of integer data read as float
    if (v !== 0 && Math.abs(v) < 1e-30) denorm++;
  }
  if (nz / n < minNonZeroFrac)
    fail(`${name}: only ${nz}/${n} entries are non-zero. Wrong offset, or the data is not there. ` +
         `A statistic over this would classify every entry identically and mean nothing.`);
  if (denorm / Math.max(1, nz) > 0.5)
    fail(`${name}: ${denorm}/${nz} non-zero values are denormal (|v| < 1e-30). That is what integer ` +
         `data read as Float32 looks like. The offset or the type is wrong.`);
  if (expectSomeNegative && neg === 0)
    fail(`${name}: no negative entries in ${n}. This array was expected to carry a sign; it does not, ` +
         `so anything computed from its sign is an artefact.`);
  return { nonZero: nz, negative: neg, checked: n };
}

/**
 * Reject a value outside the range physics allows. The body-spread probe reported a 0.25 cm animal
 * as 20 cm across for two runs before anyone asked whether that was possible.
 */
export function assertPlausible(value, name, { min = -Infinity, max = Infinity, because = '' } = {}) {
  if (!Number.isFinite(value)) fail(`${name} is ${value}`);
  if (value < min || value > max)
    fail(`${name} = ${value}, outside the plausible range [${min}, ${max}]${because ? ' -- ' + because : ''}. ` +
         `This is more likely a wrong index than a real observation.`);
  return value;
}

// ---- C. is the subject in a state where the question applies? -----------------------------------

/** A dead subject's clock never advances, so every wait burns its full timeout. Two runs lost. */
export function requireLive(subjects, { allowDead = 0 } = {}) {
  const dead = subjects.filter(s => s && s.alive === false);
  if (dead.length > allowDead)
    fail(`${dead.length} of ${subjects.length} subjects are dead. A mean over them measures a corpse, ` +
         `and a wait on them never returns.`);
  return subjects.filter(s => !s || s.alive !== false);
}

/**
 * Only measure subjects in the state the question is about. Behavioural probes were taken from
 * animals lying upside down; the motor populations then reported posture, not the stimulus.
 */
export function requirePrecondition(subjects, pred, name, { minFrac = 1 } = {}) {
  const ok = subjects.filter(pred);
  if (ok.length / Math.max(1, subjects.length) < minFrac)
    fail(`precondition "${name}" holds for only ${ok.length}/${subjects.length} subjects. ` +
         `Measuring the rest answers a different question than the one asked.`);
  return ok;
}

// ---- D. is the sampling independent of the signal? ----------------------------------------------

/**
 * Periodic sampling against a periodic signal aliases. Sampling every 50 steps while the stimulus
 * refreshed every 10 put every single sample on a refresh, and 84% of values "changed".
 */
export function assertNotAliased(samplePeriod, cadences, name = 'sampling') {
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  for (const c of cadences) {
    const g = gcd(samplePeriod, c);
    if (g === Math.min(samplePeriod, c))
      fail(`${name}: period ${samplePeriod} is aliased with a cadence of ${c} (gcd ${g}). ` +
           `Every sample will land at the same phase of that cycle. Use a period coprime to it.`);
  }
  return true;
}

// ---- E. does the effect exceed the noise? -------------------------------------------------------

/**
 * Establish a noise floor by running the SAME configuration repeatedly. Not a replication: a
 * measurement of how much this quantity moves when nothing is changed.
 *
 * Two runs of one identical configuration gave +0.03 and +2.39 on a measure about to be used to
 * report an effect of 1.65. Without the second run that would have been published.
 */
export async function noiseFloor(runOnce, n = 3, label = 'measure') {
  if (n < 2) fail('a noise floor needs at least two runs of the identical configuration');
  const vals = [];
  for (let i = 0; i < n; i++) vals.push(await runOnce(i));
  const mean = vals.reduce((a, c) => a + c, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, c) => a + (c - mean) ** 2, 0) / (vals.length - 1));
  const spread = Math.max(...vals) - Math.min(...vals);
  say(`  noise floor for ${label}: ${vals.map(v => v.toFixed(3)).join(', ')}  ` +
      `(spread ${spread.toFixed(3)}, SD ${sd.toFixed(3)}, n=${n})`);
  return { vals, mean, sd, spread };
}

/**
 * Print a conclusion ONLY if the effect clears a measured noise floor.
 *
 * Four confident, wrong verdicts in one day came from thresholds invented on the spot -- "max >
 * min * 1.3", "more than 1 Hz" -- which noise passes. This refuses to state a claim unless a floor
 * was actually measured and the effect exceeds it by the stated margin, and says so plainly when it
 * will not.
 */
export function verdict({ effect, floor, margin = 2, claim, otherwise, units = '' }) {
  if (floor === undefined || floor === null)
    fail('verdict() requires a measured noise floor. If one was not measured, the honest output is ' +
         '"effect X, noise unknown, no conclusion" -- say that instead.');
  const e = Math.abs(effect), f = Math.abs(floor);
  say('');
  say(`  effect ${effect.toFixed(3)}${units}   noise floor ${floor.toFixed(3)}${units}   ratio ${(e / (f || 1e-9)).toFixed(2)}x`);
  if (e > f * margin) { say(`  => ${claim}`); return true; }
  say(`  => NO CONCLUSION. The effect (${effect.toFixed(3)}) does not exceed the noise floor ` +
      `(${floor.toFixed(3)}) by the required ${margin}x.`);
  if (otherwise) say(`     ${otherwise}`);
  return false;
}

/**
 * A validity rule fixed before the data is seen. Trials that fail their setup must be excluded by a
 * rule written in advance; deciding afterwards which to drop is choosing the answer. Three of
 * sixteen tip trials landed upright and, by chance, all three were in one arm.
 */
export function validTrials(trials, rule, name) {
  const keep = trials.filter(rule), drop = trials.length - keep.length;
  say(`  validity rule "${name}": kept ${keep.length}/${trials.length}` +
      (drop ? `, discarded ${drop} by a rule fixed before the run` : ''));
  if (!keep.length) fail(`every trial failed the validity rule "${name}". Nothing can be concluded.`);
  return keep;
}

/** Wrap a probe so a MeasurementError prints as a refusal rather than a stack trace. */
export async function measured(fn) {
  try { await fn(); }
  catch (e) {
    if (e instanceof MeasurementError) {
      say('');
      say('  MEASUREMENT REFUSED');
      say('    ' + e.message);
      say('');
      say('  No result is reported, because a result here would not mean anything.');
      process.exitCode = 2;
      return;
    }
    throw e;
  }
}

// Does each guard actually catch the failure it was written for?
//
// A guard that never fires is worse than no guard: it adds confidence without adding checking. So
// each is given the real data that fooled the original probe, and must refuse it.
import { confirmConfig, confirmApplied, assertPopulated, assertPlausible, requireLive,
         requirePrecondition, assertNotAliased, verdict, validTrials, MeasurementError } from './rigour.mjs';

const NL = String.fromCharCode(10);
const say = (...a) => process.stdout.write(a.join(' ') + NL);
let pass = 0, fail = 0;
function caught(name, fn) {
  try { fn(); say('  NOT CAUGHT  ' + name); fail++; }
  catch (e) {
    if (e instanceof MeasurementError) { say('  caught      ' + name); pass++; }
    else { say('  WRONG ERROR ' + name + ': ' + e.message); fail++; }
  }
}
function allows(name, fn) {
  try { fn(); say('  allows      ' + name); pass++; }
  catch (e) { say('  FALSE ALARM ' + name + ': ' + e.message); fail++; }
}

say('guards, against the data that actually fooled the original probes:' + NL);

// A: the probe claimed panels were on; its URL said otherwise
caught('probe claims panels, URL says nopanels',
  () => confirmConfig('http://x/room.html?live=1&nopanels=1', { lacks: ['nopanels'] }));
allows('probe claims panels and URL agrees',
  () => confirmConfig('http://x/room.html?live=1', { lacks: ['nopanels'] }));
caught('a setting that did not apply',
  () => confirmApplied({ vncHz: 130 }, { vncHz: 3000 }, 'noci drive'));

// B: weights read at the wrong offset came back as denormals; the sign array was never negative
caught('denormal floats (integers read as Float32)',
  () => assertPopulated(new Float32Array(1000).fill(1.4e-38), 'weights'));
caught('buffer of zeros',
  () => assertPopulated(new Float32Array(1000), 'weights'));
caught('sign array with no negative entries',
  () => assertPopulated(new Float32Array(1000).fill(1.2), 'sign', { expectSomeNegative: true }));
allows('a healthy weight buffer',
  () => assertPopulated(Float32Array.from({ length: 1000 }, (_, i) => (i % 7) - 3), 'weights', { expectSomeNegative: true }));
caught('a 0.25 cm fly measured as 20 cm across',
  () => assertPlausible(20.13, 'body spread', { max: 1, because: 'a fly is 0.25 cm nose to tail' }));

// C: dead and inverted subjects
caught('two of three subjects dead',
  () => requireLive([{ alive: true }, { alive: false }, { alive: false }]));
caught('subjects upside down',
  () => requirePrecondition([{ up: -0.5 }, { up: -0.1 }, { up: 0.9 }], s => s.up > 0.7, 'upright'));

// D: sampling every 50 steps against a stimulus refreshing every 10
caught('sampling aliased with the stimulus cadence',
  () => assertNotAliased(50, [10, 20], 'change counter'));
allows('a coprime sampling period',
  () => assertNotAliased(47, [10, 20], 'change counter'));

// E: the verdict that fired on noise
say('');
say('  the verdict that fired on 117.7, 0.2, 111.0, 4.9:');
const fired = verdict({ effect: 1.65, floor: 2.36, margin: 2,
                        claim: 'THE TRIGGER HELPS', otherwise: 'Run more animals.' });
if (!fired) { say('  correctly refused'); pass++; } else { say('  WRONGLY FIRED'); fail++; }

say('');
try {
  validTrials([1, 2, 3], () => false, 'tip took');
  say('  NOT CAUGHT  all trials invalid'); fail++;
} catch (e) { say('  caught      all trials invalid'); pass++; }

say('');
say('  ' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;

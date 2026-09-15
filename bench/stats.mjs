// Inferential statistics for the behavioural experiments.
//
// WHY THIS EXISTS. Every result in this project has been reported as a bare number: "0.0302
// against 0.0177", "4,176 synapses depressed", "1.7x faster". None carried a standard deviation,
// a confidence interval, an effect size, or a test. That is adequate for engineering measurements
// where the within-cell variance is ~1%, and inadequate for behavioural claims about animals,
// where between-animal variance is the dominant term and a difference of means says little on its
// own.
//
// Everything here is standard and implemented from the definitions so it can be checked. The
// incomplete beta function follows the continued-fraction method (Press et al., 2007); the module
// self-tests against published critical values when run directly:
//
//   node bench/stats.mjs

// ---- descriptive ---------------------------------------------------------------------------
export const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

/** Sample standard deviation (n-1). Returns 0 for n < 2 rather than NaN. */
export function sd(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
export const sem = a => (a.length < 2 ? 0 : sd(a) / Math.sqrt(a.length));

/** {n, m, sd, sem, ci95:[lo,hi]} — the summary every reported measure should carry. */
export function describe(a) {
  const n = a.length, m = mean(a), s = sd(a), e = sem(a);
  const t = tCrit95(n - 1);
  return { n, m, sd: s, sem: e, ci95: [m - t * e, m + t * e] };
}

// ---- the t distribution ---------------------------------------------------------------------
function gammaln(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
             -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

/** Continued fraction for the incomplete beta function (Lentz's method). */
function betacf(a, b, x) {
  const FPMIN = 1e-300, EPS = 3e-12;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a,b). */
export function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}

/** Two-tailed p for Student's t with df degrees of freedom. */
export function tp(t, df) {
  if (!(df > 0) || !Number.isFinite(t)) return NaN;
  return betai(df / 2, 0.5, df / (df + t * t));
}

/** Two-tailed 95% critical t, by bisection on tp(). Used for confidence intervals. */
export function tCrit95(df) {
  if (!(df > 0)) return NaN;
  let lo = 0, hi = 100;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tp(mid, df) > 0.05) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---- comparisons -----------------------------------------------------------------------------
/** Cohen's d with the pooled standard deviation. */
export function cohensD(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return NaN;
  const sp = Math.sqrt(((na - 1) * sd(a) ** 2 + (nb - 1) * sd(b) ** 2) / (na + nb - 2));
  return sp === 0 ? NaN : (mean(a) - mean(b)) / sp;
}

/**
 * Welch's t test — unequal variances not assumed away, which is the right default when two
 * conditions may differ in spread as well as in mean.
 */
export function welch(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return { t: NaN, df: NaN, p: NaN, d: NaN, diff: mean(a) - mean(b) };
  const va = sd(a) ** 2 / na, vb = sd(b) ** 2 / nb;
  const t = (mean(a) - mean(b)) / Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / (va ** 2 / (na - 1) + vb ** 2 / (nb - 1));
  return { t, df, p: tp(t, df), d: cohensD(a, b), diff: mean(a) - mean(b) };
}

/** Paired t test — for within-animal comparisons such as baseline against treatment. */
export function paired(a, b) {
  if (a.length !== b.length || a.length < 2) return { t: NaN, df: NaN, p: NaN, d: NaN, diff: NaN };
  const d = a.map((x, i) => x - b[i]);
  const t = mean(d) / (sd(d) / Math.sqrt(d.length));
  return { t, df: d.length - 1, p: tp(t, d.length - 1), d: mean(d) / sd(d), diff: mean(d) };
}

/**
 * Smallest effect size detectable at the given n, alpha and power (two-sample, two-tailed).
 * Reported alongside null results so "we found nothing" can be read as "with this n we could only
 * have found something enormous".
 */
export function minDetectableD(nPerGroup, power = 0.8) {
  if (nPerGroup < 2) return Infinity;
  // normal approximation: d = (z_{1-a/2} + z_{1-b}) * sqrt(2/n)
  const z = { 0.8: 0.8416, 0.9: 1.2816, 0.95: 1.6449 }[power] ?? 0.8416;
  return (1.96 + z) * Math.sqrt(2 / nPerGroup);
}

// ---- reporting -------------------------------------------------------------------------------
const f = (x, n = 3) => (Number.isFinite(x) ? x.toFixed(n) : '—');
/** APA-ish inline summary: M = 0.31, SD = 0.04, 95% CI [0.26, 0.36] */
export function apaDescribe(a, n = 3) {
  const d = describe(a);
  return `M = ${f(d.m, n)}, SD = ${f(d.sd, n)}, 95% CI [${f(d.ci95[0], n)}, ${f(d.ci95[1], n)}]`;
}
/** APA-ish test summary: t(3.8) = 4.21, p = .018, d = 2.44 */
export function apaTest(r) {
  const p = Number.isFinite(r.p)
    ? (r.p < 0.001 ? 'p < .001' : `p = ${r.p.toFixed(3).replace(/^0/, '')}`)
    : 'p = —';
  return `t(${f(r.df, 1)}) = ${f(r.t, 2)}, ${p}, d = ${f(r.d, 2)}`;
}

// ---- self test -------------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('stats.mjs')) {
  const near = (a, b, tol, what) => {
    const ok = Math.abs(a - b) < tol;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}: got ${a.toFixed(4)}, expected ~${b}`);
    return ok;
  };
  console.log('stats self-test (against published values)');
  let ok = true;
  // two-tailed critical t at alpha .05
  ok &= near(tCrit95(10), 2.228, 0.002, 't crit df=10');
  ok &= near(tCrit95(1), 12.706, 0.01, 't crit df=1');
  ok &= near(tCrit95(30), 2.042, 0.002, 't crit df=30');
  ok &= near(tCrit95(100), 1.984, 0.002, 't crit df=100');
  // p values
  ok &= near(tp(2.228, 10), 0.05, 0.001, 'p(t=2.228, df=10)');
  ok &= near(tp(0, 10), 1.0, 1e-9, 'p(t=0)');
  ok &= near(tp(4.587, 10), 0.001, 0.0002, 'p(t=4.587, df=10)');
  // descriptives against hand computation
  const x = [2, 4, 4, 4, 5, 5, 7, 9];
  ok &= near(mean(x), 5.0, 1e-9, 'mean');
  ok &= near(sd(x), 2.1381, 0.001, 'sample SD (n-1)');
  // Welch on clearly separated samples
  const w = welch([10, 11, 12, 11, 10], [1, 2, 1, 2, 1]);
  ok &= near(w.p < 0.001 ? 0 : 1, 0, 0.5, 'Welch separates distinct samples (p < .001)');
  ok &= near(cohensD([10, 11, 12, 11, 10], [1, 2, 1, 2, 1]) > 8 ? 1 : 0, 1, 0.5, "Cohen's d is large");
  // power
  ok &= near(minDetectableD(3), 2.29, 0.05, 'min detectable d at n=3');
  ok &= near(minDetectableD(30), 0.72, 0.02, 'min detectable d at n=30');
  console.log(ok ? '\nall statistics checks passed' : '\nSTATISTICS SELF-TEST FAILED');
  process.exitCode = ok ? 0 : 1;
}

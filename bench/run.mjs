// Drives bench.html in a real Chrome with background throttling disabled.
//
// WHY. The headless page (bench.html) removes rendering, but it cannot remove *throttling*:
// Chrome slows a hidden or occluded tab's timers by roughly 40x, and that is browser policy, not
// something a page can opt out of. Measured on one page minutes apart: 0.0366x actively polled,
// 0.0009x left alone. So every unattended measurement taken through a normal window is suspect,
// and the page can only detect it after the fact and mark the row DIRTY.
//
// Launching Chrome ourselves with the three backgrounding flags removes the problem at the
// source, so a ramp can run unattended and still be trustworthy.
//
// WHY puppeteer-core AND NOT puppeteer. `puppeteer` downloads its own ~200 MB Chromium. That
// would be the wrong browser: on a switchable-graphics laptop the discrete GPU is selected per
// executable (the GpuPreference registry entry names chrome.exe), so a bundled Chromium lands
// back on the integrated GPU -- which is exactly the trap that made an earlier WebGPU benchmark
// read 32x slower than it should have. puppeteer-core ships no browser and drives the installed
// Chrome, which already has the preference.
//
// USAGE
//   node bench/run.mjs                                   default 1..6 ramp, randomised
//   node bench/run.mjs --flies=1,3,6 --repeats=5
//   node bench/run.mjs --vision=0 --props=0              passed through to the page
//   node bench/run.mjs --show                            visible window, for watching it work
//   node bench/run.mjs --url=http://localhost:5173       if the dev server is on another port
//
// The dev server must already be running (npm run dev). This script never starts or stops it.

import { launch } from 'puppeteer-core';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
];

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));

const BASE = (args.url || 'http://localhost:5173').replace(/\/$/, '');
const SHOW = args.show === 'true';
const chromePath = args.chrome || CHROME_CANDIDATES.find(p => p && existsSync(p));
if (!chromePath) {
  console.error('Could not find Chrome. Pass --chrome="C:/path/to/chrome.exe".');
  process.exit(1);
}

// Everything the page understands, forwarded as-is.
const PASS = ['flies', 'repeats', 'window', 'warm', 'order', 'vision', 'props', 'gpu', 'noci'];
const q = new URLSearchParams();
for (const k of PASS) if (args[k] !== undefined) q.set(k, args[k]);
if (!q.has('flies')) q.set('flies', '1,2,3,4,5,6');
if (!q.has('order')) q.set('order', 'random');    // decouple the variable from time by default
const url = `${BASE}/bench.html?${q}`;

// A ramp is long: 6 points x (10 s settle + warm + repeats x window). Budget generously.
const pts = q.get('flies').split(',').length;
const perPoint = 10 + (Number(q.get('warm') ?? 2) + Number(q.get('repeats') ?? 3)) * Number(q.get('window') ?? 20);
const budgetMs = (pts * perPoint + 420) * 1000;   // + connectome load and slack

console.log(`chrome     ${chromePath}`);
console.log(`url        ${url}`);
console.log(`budget     ${Math.round(budgetMs / 60000)} min`);
console.log('');

const browser = await launch({
  executablePath: chromePath,
  headless: SHOW ? false : 'new',
  // The page's main thread is busy simulating, so CDP evaluations queue behind it. Puppeteer's
  // default 180 s protocol timeout fires long before a ramp finishes; the run's own budget is
  // the real limit.
  protocolTimeout: 0,
  // A fresh profile, OUTSIDE the project. The user's own Chrome profile may be in use and its
  // extensions would compete for CPU with the thing being measured -- but the profile must also
  // live outside the repo, because Chrome keeps session files locked and Vite's watcher dies
  // with EBUSY trying to watch them, taking the dev server (and the run) down with it.
  userDataDir: join(tmpdir(), 'naf-bench-chrome-profile'),
  args: [
    // the point of the whole exercise
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    // SharedArrayBuffer needs cross-origin isolation; the page ships a COOP/COEP service worker,
    // but this makes it independent of whether that worker has activated yet.
    '--enable-features=SharedArrayBuffer',
    // headless Chrome defaults to a software rasteriser; these let it reach the real GPU
    '--use-gl=angle', '--use-angle=default', '--enable-unsafe-webgpu',
    '--window-size=1280,800',
  ],
});

try {
  const page = await browser.newPage();
  page.on('console', m => { const t = m.text(); if (/^(headless bench|points|\s*\d+ flies|flies,|WARNING|AT LEAST)/.test(t)) console.log(t); });
  page.on('pageerror', e => console.error('page error:', e.message));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

  // Report the adapter the page actually got. A benchmark that does not say which physical
  // device it ran on is not a benchmark -- this cost hours earlier in the project.
  const gpu = await page.evaluate(async () => {
    try { const a = await navigator.gpu?.requestAdapter();
      return a ? (a.info?.description || a.info?.vendor || 'adapter, no info') : 'no WebGPU adapter'; }
    catch (e) { return 'error: ' + e.message; }
  });
  const isolated = await page.evaluate(() => crossOriginIsolated);
  console.log(`adapter    ${gpu}`);
  console.log(`isolated   ${isolated}${isolated ? '' : '   <-- SharedArrayBuffer unavailable, the run will fail'}`);
  console.log('');

  // Poll from Node rather than with waitForFunction: a page-side polling task competes with the
  // very workers being measured, and a stuck evaluation takes the whole run down with it.
  const deadline = Date.now() + budgetMs;
  let rowsReady = false;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    try { rowsReady = await page.evaluate(() => !!window.__benchRows); } catch { /* busy, retry */ }
    if (rowsReady) break;
  }
  if (!rowsReady) throw new Error(`bench did not finish within ${Math.round(budgetMs / 60000)} min`);
  const rows = await page.evaluate(() => window.__benchRows);

  console.log('');
  console.log('flies,aggregate,perFly,spreadPct,dirty,dead');
  for (const r of rows) console.log(`${r.flies},${r.aggregate},${r.perFly},${r.spreadPct},${r.dirty},${r.dead}`);

  const dirty = rows.filter(r => r.dirty);
  console.log('');
  console.log(dirty.length
    ? `${dirty.length} point(s) still flagged DIRTY despite the throttling flags -- do not trust them.`
    : 'No point was throttled. Results are clean.');

  mkdirSync(join(HERE, 'results'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(HERE, 'results', `ramp-${stamp}.json`);
  writeFileSync(file, JSON.stringify({ url, adapter: gpu, crossOriginIsolated: isolated,
    chrome: chromePath, when: new Date().toISOString(), rows }, null, 2));
  console.log(`\nwritten    ${file}`);
} finally {
  await browser.close();
}

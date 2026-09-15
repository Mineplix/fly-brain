// Runs the defensive-arousal paradigm unattended, in a real Chrome with throttling disabled.
//
// The experiment needs tens of simulated seconds with vision ON (a looming stimulus is visual, so
// ?vision=0 is not available as a speed-up), which through the preview pane meant hours of
// babysitting at a ~40x throttle. Here it runs on the discrete GPU with the backgrounding flags
// off, so it can be left alone.
//
//   node bench/run-arousal.mjs
//   node bench/run-arousal.mjs --flies=3 --passes=0,3,8

import { launch } from 'puppeteer-core';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find(p => p && existsSync(p));
if (!CHROME) { console.error('Chrome not found'); process.exit(1); }

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const BASE = (args.url || 'http://localhost:5173').replace(/\/$/, '');
const N = Number(args.flies || 3);
const q = new URLSearchParams({ arousal: '1', flies: String(N), persist: '0', ringmaster: '0' });
for (const k of ['passes', 'base', 'post', 'bin', 'wash', 'noci']) if (args[k]) q.set(k, args[k]);
const url = `${BASE}/arena.html?${q}`;

const browser = await launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 0,
  // Per-process profile. A shared one deadlocks the next run if a previous Chrome was left
  // holding it -- puppeteer refuses to launch and the whole harness dies before it starts.
  userDataDir: join(tmpdir(), `naf-arousal-${process.pid}`),
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows', '--enable-unsafe-webgpu',
         '--use-gl=angle', '--use-angle=default', '--window-size=1280,800'],
});

const page = await browser.newPage();
page.on('pageerror', e => console.error('page error:', e.message));
page.on('console', m => { const t = m.text(); if (t.startsWith('[arousal]')) console.log(t.slice(10)); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  console.log(`url  ${url}\n`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });

  // wait for the arena, then add replicates beyond the preset's single fly
  const end0 = Date.now() + 600000;
  while (Date.now() < end0) {
    await sleep(4000);
    try { if (await page.evaluate(() => !!window.__arena && window.__arena.flies.some(f => f.ready))) break; } catch {}
  }
  console.log(`adapter  ${await page.evaluate(async () => { const a = await navigator.gpu?.requestAdapter(); return a?.info?.description || a?.info?.vendor || 'none'; })}`);

  await page.evaluate(async (n) => {
    const a = window.__arena;
    while (a.flies.length < n) {
      const k = a.flies.length, th = k * 2.2;
      await a.addFly([1.2 * Math.cos(th), 1.2 * Math.sin(th)], th, 'm', { name: `rep${k}`, sex: 'm' });
    }
    document.querySelector('#speed').value = 2;
    document.querySelector('#speed').dispatchEvent(new Event('input'));
    if (!/Pause/.test(document.querySelector('#play').textContent)) document.querySelector('#play').click();
  }, N);
  console.log(`flies    ${(await page.evaluate(() => window.__arena.flies.map(f => f.name))).join(', ')}\n`);

  const deadline = Date.now() + 90 * 60000;
  let done = false;
  while (Date.now() < deadline) {
    await sleep(10000);
    try { done = await page.evaluate(() => !!window.__arousalResults); } catch {}
    if (done) break;
  }
  if (!done) throw new Error('arousal run did not finish within 90 min');

  const rows = await page.evaluate(() => window.__arousalResults);
  mkdirSync(join(HERE, 'results'), { recursive: true });
  const file = join(HERE, 'results', `arousal-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ url, when: new Date().toISOString(), rows }, null, 2));
  console.log(`\nwritten  ${file}`);
} finally {
  await browser.close();
}

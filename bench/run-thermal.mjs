// Runs the thermal-escape validation unattended, in a real Chrome with throttling disabled.
//
// The experiment needs tens of simulated seconds with vision ON (a looming stimulus is visual, so
// ?vision=0 is not available as a speed-up), which through the preview pane meant hours of
// babysitting at a ~40x throttle. Here it runs on the discrete GPU with the backgrounding flags
// off, so it can be left alone.
//
//   node bench/run-thermal.mjs
//   node bench/run-thermal.mjs --flies=6 --hot=6 --vision=1

import { launch } from 'puppeteer-core';
import { describe, welch, paired, apaDescribe, apaTest, minDetectableD } from './stats.mjs';
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
const q = new URLSearchParams({ thermal: '1', flies: String(N), persist: '0', ringmaster: '0' });
for (const k of ['base', 'hot', 'post', 'wash']) if (args[k]) q.set(k, args[k]);
if (args.vision !== '1') q.set('vision', '0');   // the stimulus is thermal, not visual
if (args.noci !== '0') q.set('noci', '1');       // the animals feel the floor unless told otherwise
const url = `${BASE}/arena.html?${q}`;

const browser = await launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 0,
  // Per-process profile. A shared one deadlocks the next run if a previous Chrome was left
  // holding it -- puppeteer refuses to launch and the whole harness dies before it starts.
  userDataDir: join(tmpdir(), `naf-thermal-${process.pid}`),
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows', '--enable-unsafe-webgpu',
         '--use-gl=angle', '--use-angle=default', '--window-size=1280,800'],
});

const page = await browser.newPage();
page.on('pageerror', e => console.error('page error:', e.message));
page.on('console', m => { const t = m.text(); if (t.startsWith('[thermal]')) console.log(t.slice(10)); });
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
    try { done = await page.evaluate(() => !!window.__thermalResults); } catch {}
    if (done) break;
  }
  if (!done) throw new Error('thermal run did not finish within 90 min');

  const rows = await page.evaluate(() => window.__thermalResults);

  // ---- inferential analysis, done in Node rather than in the page ---------------------------
  // The page collects; Node analyses. Each fly is one independent replicate (its own worker and
  // brain seed), so the unit of analysis is the animal, not the sample.
  const ctrl = rows.find(r => !r.lava), hot = rows.find(r => r.lava);
  if (!ctrl || !hot) {
    console.log('\na condition is missing — no analysis possible.');
  } else {
    const n = hot.treat.length, mdd = minDetectableD(n);
    console.log('\n================ inferential analysis ================');
    console.log(`n = ${n} animals per condition (independent workers, seeds 101+id)`);
    console.log(`smallest effect detectable at n=${n}, alpha .05, power .80:  d = ${mdd.toFixed(2)}`);
    console.log('a null below that d means the design could not have found it, not that it is absent.\n');

    const report = (label, k, unit) => {
      const c = ctrl.treat.map(r => r[k]), h = hot.treat.map(r => r[k]);
      const w = welch(h, c);
      console.log(label);
      console.log(`   control  ${apaDescribe(c)}${unit || ''}`);
      console.log(`   lava     ${apaDescribe(h)}${unit || ''}`);
      console.log(`   Welch    ${apaTest(w)}   diff ${w.diff >= 0 ? '+' : ''}${w.diff.toFixed(3)}${unit || ''}`);
      const verdict = !Number.isFinite(w.p) ? 'not testable at this n'
        : w.p < 0.05 ? 'SIGNIFICANT at .05'
        : Math.abs(w.d) > mdd ? 'large d but not significant — spread is inconsistent, treat with caution'
        : `no detectable effect (|d| = ${Math.abs(w.d).toFixed(2)} < ${mdd.toFixed(2)})`;
      console.log(`   verdict  ${verdict}\n`);
      return w;
    };

    console.log('--- between conditions, during treatment ---');
    report('height above floor (cm)', 'z', '');
    report('time below the nociceptive floor (%)', 'safePct', '%');
    report('time in flight (%)', 'flyPct', '%');
    report('height gained on foot (cm)', 'climbed', '');

    console.log('--- within animal: baseline against treatment ---');
    for (const [name, cond] of [['control', ctrl], ['lava', hot]]) {
      const b = cond.base.map(r => r.z), t = cond.treat.map(r => r.z);
      console.log(`${name.padEnd(8)} baseline ${apaDescribe(b)}`);
      console.log(`         treated  ${apaDescribe(t)}`);
      console.log(`         paired   ${apaTest(paired(t, b))}\n`);
    }

    // Everything above assumes the two conditions started from the same place.
    const bd = welch(hot.base.map(r => r.z), ctrl.base.map(r => r.z));
    console.log('--- baseline comparability (the assumption the rest rests on) ---');
    console.log(`   ${apaTest(bd)}   difference ${bd.diff >= 0 ? '+' : ''}${bd.diff.toFixed(3)} cm`);
    console.log(Number.isFinite(bd.p) && bd.p < 0.05
      ? '   BASELINES DIFFER SIGNIFICANTLY — the between-condition tests are confounded. Discard them.'
      : '   baselines are statistically indistinguishable; the comparison is interpretable.');
  }
  mkdirSync(join(HERE, 'results'), { recursive: true });
  const file = join(HERE, 'results', `thermal-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ url, when: new Date().toISOString(), rows }, null, 2));
  console.log(`\nwritten  ${file}`);
} finally {
  await browser.close();
}

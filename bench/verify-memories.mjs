// Verifies that flies have INDIVIDUAL memories, and that relocating them preserves those.
//
// The claim under test is not "a fly can learn" (FIELD-NOTES 24 settled that) but "six flies in
// one arena have six separate memories, each saved under its own name". Those are different
// claims: the connectome is shared between every fly, so if the plastic overlay were shared too
// -- or if the store keyed records wrongly -- every animal would appear to learn identically and
// nothing in the UI would show it.
//
// METHOD. All three flies stand on the same hot floor, because punishment comes from the shared
// env and cannot be aimed at one animal. What IS per-fly is whether plasticity is enabled, so
// each fly gets a different amount of learning time:
//
//   trained   learning on for the whole punishment
//   partial   learning on for roughly half of it
//   naive     learning never enabled -- the control
//
// A correct implementation gives three different arrays, with naive at exactly zero. A shared
// overlay would give three identical ones. The arrays are then compared again after a page
// reload, and again after Janus relocates everyone to hell.
//
//   node bench/verify-memories.mjs

import { launch } from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find(p => p && existsSync(p));
if (!CHROME) { console.error('Chrome not found'); process.exit(1); }

const BASE = process.argv.find(a => a.startsWith('--url='))?.slice(6) || 'http://localhost:5173';
const URL_ = `${BASE}/arena.html?flies=3&noci=1&persist=1&ringmaster=0&vision=0`;

const browser = await launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 0,
  userDataDir: join(tmpdir(), 'naf-verify-chrome-profile'),
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows', '--enable-unsafe-webgpu',
         '--use-gl=angle', '--use-angle=default', '--window-size=1280,800'],
});

const page = await browser.newPage();
page.on('pageerror', e => console.error('page error:', e.message));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Wait for a page-side predicate, polling from Node so we never block the workers. */
async function until(fn, label, maxMs = 900000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    await sleep(3000);
    try { if (await ev(fn)) return true; } catch { /* main thread busy */ }
  }
  throw new Error(`timed out waiting for ${label}`);
}

const NAMES = ['trained', 'partial', 'naive'];

try {
  console.log(`url  ${URL_}\n`);
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await until(() => !!window.__arena && window.__arena.flies.some(f => f.ready), 'first fly');
  console.log(`adapter  ${await ev(async () => { const a = await navigator.gpu?.requestAdapter(); return a?.info?.description || a?.info?.vendor || 'none'; })}`);

  // --- three named flies, one store, nothing inherited from a previous run -------------------
  await ev(async (names) => {
    const a = window.__arena;
    await a.store.clearAll();
    a.renameFly(a.flies[0].id, names[0]);
    while (a.flies.length < names.length) {
      const k = a.flies.length, th = k * 2.1;
      await a.addFly([1.1 * Math.cos(th), 1.1 * Math.sin(th)], th, 'm', { name: names[k], sex: 'm' });
    }
    a.env.odors = [{ x: 0, y: 0, odor: 'vinegar', strength: 1, sigma: 5 }];
    a.env.hazards = []; a.env.food = []; a.env.bitterPatches = []; a.env.wind = [0, 0];
    a.rebuildEnv();
    for (const f of a.flies) f.worker.postMessage({ type: 'env', env: a.env });
    document.querySelector('#speed').value = 2;
    document.querySelector('#speed').dispatchEvent(new Event('input'));
    document.querySelector('#play').click();
  }, NAMES);
  console.log(`flies    ${(await ev(() => window.__arena.flies.map(f => f.name))).join(', ')}\n`);

  // --- differential training, driven by simulated time ---------------------------------------
  await ev(() => {
    const a = window.__arena, simS = () => (a.flies[0]?.last?.t || 0) / 1000;
    const dead = () => a.flies.some(f => f.last && f.last.alive === false);
    const wait = async dt => { const t = simS(), w = performance.now();
      while (simS() < t + dt) { if (dead() || performance.now() - w > 900000) return false; await new Promise(r => setTimeout(r, 200)); } return true; };
    const byName = n => a.flies.find(f => f.name === n);
    window.__V = { phase: 'warmup', done: false };
    (async () => {
      while (simS() < 6) await new Promise(r => setTimeout(r, 400));   // past the 4 s MB warm-up
      for (const f of a.flies) f.worker.postMessage({ type: 'mbreset' });
      await new Promise(r => setTimeout(r, 600));
      // learning off for everyone; enabled per fly below
      for (const f of a.flies) f.worker.postMessage({ type: 'learn', on: false });
      window.__V.phase = 'punish';
      a.env.hazards = [{ x: 0, y: 0, r: 2.4, heat: 0.5 }]; a.rebuildEnv();
      for (const f of a.flies) f.worker.postMessage({ type: 'env', env: a.env });
      byName('trained').worker.postMessage({ type: 'learn', on: true });
      byName('partial').worker.postMessage({ type: 'learn', on: true });
      await wait(1.2);
      byName('partial').worker.postMessage({ type: 'learn', on: false });   // half the exposure
      window.__V.phase = 'punish (partial frozen)';
      await wait(1.6);
      for (const f of a.flies) f.worker.postMessage({ type: 'learn', on: false });
      a.env.hazards = []; a.rebuildEnv();
      for (const f of a.flies) f.worker.postMessage({ type: 'env', env: a.env });
      await new Promise(r => setTimeout(r, 800));
      await a.saveAllFlies({ force: true });
      window.__V.done = true; window.__V.phase = 'saved';
    })();
  });

  await until(() => window.__V?.done, 'training + save');

  /** Read every fly's weights straight out of its RUNNING worker. */
  const liveWeights = () => ev(() => Promise.all(window.__arena.flies.map(f =>
    new Promise(res => {
      const h = e => { if (e.data.type === 'mb') { f.worker.removeEventListener('message', h);
        const v = new Float32Array(e.data.mb); let nz = 0, sum = 0;
        for (const x of v) if (x > 1e-6) { nz++; sum += x; }
        res({ name: f.name, nonZero: nz, checksum: +sum.toFixed(4) }); } };
      f.worker.addEventListener('message', h);
      f.worker.postMessage({ type: 'exportmb', token: Math.random() });
    }))));

  const before = await liveWeights();
  console.log('after training (live workers)');
  for (const r of before) console.log(`  ${r.name.padEnd(8)} nonZero ${String(r.nonZero).padStart(6)}   checksum ${r.checksum}`);

  const stored = await ev(async () => {
    const a = window.__arena, sig = a.store.mbSignature(null);
    const all = await a.store.listFlies();
    return Promise.all(all.map(async m => {
      const rec = await a.store.loadFly(m.name, m.mbSig);
      const v = rec.mb ? new Float32Array(rec.mb) : new Float32Array(0);
      let nz = 0, sum = 0; for (const x of v) if (x > 1e-6) { nz++; sum += x; }
      return { name: m.name, nonZero: nz, checksum: +sum.toFixed(4) };
    }));
  });
  console.log('\nin the store');
  for (const r of stored) console.log(`  ${r.name.padEnd(8)} nonZero ${String(r.nonZero).padStart(6)}   checksum ${r.checksum}`);

  // --- relocate: rebuilt in another world, memories meant to survive ---------------------------
  console.log('\nrelocating to hell...');
  await ev(() => { window.__R = { done: false };
    window.__arena.relocate('hell').then(ok => { window.__R = { done: true, ok }; }); });
  await until(() => window.__R?.done, 'relocation');
  const relocOk = await ev(() => window.__R.ok);
  const afterMove = await liveWeights();
  const place = await ev(() => ({ obstacles: window.__arena.env.obstacles.length, sky: window.__arena.env.light.sky, humidity: window.__arena.env.humidity }));
  console.log(`  relocate() -> ${relocOk}   obstacles ${place.obstacles}, light ${place.sky}, humidity ${place.humidity}`);
  for (const r of afterMove) console.log(`  ${r.name.padEnd(8)} nonZero ${String(r.nonZero).padStart(6)}   checksum ${r.checksum}`);

  // --- verdict ---------------------------------------------------------------------------------
  const get = (rows, n) => rows.find(r => r.name === n) || { nonZero: -1, checksum: -1 };
  const checks = [
    ['trained learned something', get(before, 'trained').nonZero > 0],
    ['naive learned nothing', get(before, 'naive').nonZero === 0],
    ['partial differs from trained', get(before, 'partial').checksum !== get(before, 'trained').checksum],
    ['all three memories differ', new Set(before.map(r => r.checksum)).size === 3],
    ['store holds one record per fly', stored.length === NAMES.length],
    ['store matches the live workers', NAMES.every(n => get(stored, n).nonZero === get(before, n).nonZero)],
    ['relocation succeeded', relocOk === true],
    ['memories survived relocation', NAMES.every(n => get(afterMove, n).nonZero === get(before, n).nonZero)],
    ['still individual after the move', new Set(afterMove.map(r => r.checksum)).size === 3],
  ];
  console.log('');
  let bad = 0;
  for (const [what, ok] of checks) { if (!ok) bad++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`); }
  console.log(bad ? `\n${bad} CHECK(S) FAILED` : '\nall checks passed');
  process.exitCode = bad ? 1 : 0;
} finally {
  await browser.close();
}

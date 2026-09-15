// System smoke test: loads the arena and exercises every subsystem that has broken this session,
// reporting console errors, page errors, and per-check pass/fail.
//
// This exists because three separate failures reached the browser undetected -- a temporal dead
// zone error that stopped the page loading, an alert() that froze a headless renderer, and an
// odour plume drawn so large it read as the floor colour. None would have been caught by a syntax
// check or a build, and all three were found by a human looking at the screen. This automates the
// looking.
//
//   node bench/smoke.mjs
//   node bench/smoke.mjs --keep      leave the browser open at the end

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
const KEEP = process.argv.includes('--keep');

const browser = await launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 0,
  userDataDir: join(tmpdir(), `naf-smoke-${process.pid}`),
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows', '--enable-unsafe-webgpu',
         '--use-gl=angle', '--use-angle=default', '--window-size=1280,800'],
});

const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
async function until(fn, label, maxMs = 600000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) { await sleep(3000); try { if (await ev(fn)) return true; } catch {} }
  throw new Error(`timed out: ${label}`);
}

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`); };

try {
  // Ringmaster on, persistence off: this is a functional sweep, not a measurement, and it must
  // not write into the user's saved flies.
  const url = `${BASE}/arena.html?flies=3&persist=0&ringmaster=1&vision=0`;
  console.log(`url  ${url}\n`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await until(() => !!window.__arena && window.__arena.flies.some(f => f.ready), 'arena ready');

  console.log('load');
  check('page reached a ready arena', true);
  check('no errors during load', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log('\nstaging: every place builds');
  const stages = await ev(() => {
    const a = window.__arena, out = [];
    for (const name of Object.keys(a.LOOKS)) {
      try {
        const env = structuredClone(a.env);
        env.obstacles = []; env.hazards = []; env.bitterPatches = [];
        const look = a.stageInto(env, name);
        out.push({ name, obstacles: env.obstacles.length, ok: !!look,
          shape: env.arena.shape, wall: env.arena.wallHeight,
          albedo: !!(look.albedo && Number.isFinite(look.albedo.floorLo)) });
      } catch (e) { out.push({ name, ok: false, err: String(e.message) }); }
    }
    return out;
  });
  for (const s of stages) check(`stage ${s.name}`, s.ok && s.albedo, s.err || `${s.obstacles} obstacles, ${s.shape}, wall ${s.wall}`);

  console.log('\nfly lifecycle');
  const life = await ev(async () => {
    const a = window.__arena, before = a.flies.length;
    const f = await a.addFly([0.5, 0.5], 0, 'f', { name: 'smoke-female', sex: 'f' });
    const added = a.flies.length === before + 1 && f?.sex === 'f';
    const renamed = a.renameFly(f.id, 'smoke-renamed') && a.flies.some(x => x.name === 'smoke-renamed');
    const eyeRows = document.querySelectorAll('#eyerows .eyerow').length;
    const removed = a.removeFly(f.id) && a.flies.length === before;
    return { added, renamed, removed, eyeRows, flies: a.flies.length };
  });
  check('addFly creates a female', life.added);
  check('renameFly works', life.renamed);
  check('one eye row per fly', life.eyeRows === life.flies + 1, `${life.eyeRows} rows for ${life.flies + 1} flies`);
  check('removeFly frees the slot', life.removed);

  console.log('\nJanus');
  const janus = await ev(() => {
    const r = window.__ringmaster; if (!r) return { ok: false };
    const cmds = ['sugar hunt', 'lights out', 'monster', 'beach', 'hell', 'obstacle course', 'nonsense wobble'];
    return { ok: true, parsed: cmds.map(c => ({ c, r: r.command(c) })), places: r.places };
  });
  check('ringmaster is running', janus.ok);
  if (janus.ok) {
    const byCmd = Object.fromEntries(janus.parsed.map(p => [p.c, p.r]));
    check('scene command parses', !!byCmd['sugar hunt'], String(byCmd['sugar hunt']));
    check('place command parses', String(byCmd['beach'] || '').startsWith('place:'), String(byCmd['beach']));
    check('place beats adventure for "hell"', String(byCmd['hell'] || '').startsWith('place:'), String(byCmd['hell']));
    check('unknown command is refused', byCmd['nonsense wobble'] === null);
    check('all places reachable', (janus.places || []).length >= 8, (janus.places || []).join(','));
  }

  console.log('\norb and monster');
  await ev(() => { window.__arena.recallMonster?.(); window.__arena.janusSpeak?.(6000); });
  await sleep(4000);
  const orb = await ev(() => ({ present: !!window.__arena.env.janus, d: window.__arena.orbDebug?.() }));
  check('orb materialises when Janus speaks', orb.present, orb.d ? `presence ${orb.d.presence.toFixed(2)}` : '');
  const mon = await ev(() => ({ released: window.__arena.releaseMonster?.(12000), env: !!window.__arena.env.monster }));
  await sleep(3000);
  const mon2 = await ev(() => ({ env: !!window.__arena.env.monster, pos: window.__arena.env.monster }));
  check('monster releases and is mirrored to workers', mon.released && mon2.env);
  await ev(() => window.__arena.recallMonster?.());
  await sleep(1500);
  check('monster recalls cleanly', await ev(() => window.__arena.env.monster === null));

  console.log('\nrelocation (rebuilds every fly)');
  const relo = await ev(async () => {
    const a = window.__arena;
    const names = a.flies.map(f => f.name).sort();
    const t0 = performance.now();
    const ok = await a.relocate('beach');
    return { ok, ms: Math.round(performance.now() - t0), names,
      after: a.flies.map(f => f.name).sort(), obstacles: a.env.obstacles.length,
      humidity: a.env.humidity, light: a.env.light.sky };
  });
  check('relocate returns true', relo.ok, `${relo.ms} ms`);
  check('every fly survives relocation', JSON.stringify(relo.names) === JSON.stringify(relo.after),
    `${relo.names.join(',')} -> ${relo.after.join(',')}`);
  check('the destination is actually staged', relo.humidity === 0.85 && relo.light === 1.4,
    `${relo.obstacles} obstacles, humidity ${relo.humidity}, light ${relo.light}`);

  console.log('\nbrain panel');
  const panel = await ev(() => {
    const rows = [...document.querySelectorAll('#groups .g')];
    const badged = rows.filter(r => r.querySelector('em.nosoma')).map(r => r.querySelector('.name').textContent.trim().split(' ')[0]);
    return { rows: rows.length, badged, stack: document.querySelectorAll('#stLabels .r').length };
  });
  check('group rows built', panel.rows > 0, `${panel.rows} groups`);
  check('unplottable groups are badged', panel.badged.length >= 2, panel.badged.join(', '));
  check('stack has a row per fly', panel.stack === (await ev(() => window.__arena.flies.length)), `${panel.stack} rows`);

  console.log('\nerrors seen during the whole sweep');
  check('no runtime errors', errors.length === 0, errors.slice(0, 5).join(' | ') || 'none');

  const failed = checks.filter(c => !c.ok);
  console.log('');
  console.log(failed.length ? `${failed.length} of ${checks.length} CHECKS FAILED` : `all ${checks.length} checks passed`);
  if (failed.length) for (const f of failed) console.log(`  FAILED: ${f.name}  ${f.detail}`);
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error('\nsmoke test aborted:', e.message);
  if (errors.length) console.error('errors seen:\n  ' + errors.slice(0, 8).join('\n  '));
  process.exitCode = 1;
} finally {
  if (!KEEP) await browser.close();
}

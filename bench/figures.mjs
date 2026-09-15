// Generates the figures for RESEARCH-PAPER: real captures from the running artefact, plus data
// charts drawn from measured numbers.
//
// Captures are taken from the arena itself rather than mocked up, so what the paper shows is what
// the system actually renders. The neural-mapping panels use the group highlight, including the
// terminal-position fallback for peripheral afferents that have no soma coordinates.
//
//   node bench/figures.mjs           writes paper/fig*.png

import { launch } from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'paper');
mkdirSync(OUT, { recursive: true });

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find(p => p && existsSync(p));
if (!CHROME) { console.error('Chrome not found'); process.exit(1); }
const BASE = process.argv.find(a => a.startsWith('--url='))?.slice(6) || 'http://localhost:5173';

const browser = await launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 0,
  userDataDir: join(tmpdir(), `naf-fig-${process.pid}`),
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows', '--enable-unsafe-webgpu',
         '--use-gl=angle', '--use-angle=default', '--window-size=1600,1000'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
page.on('pageerror', e => console.error('page error:', e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const save = (name, b64) => { writeFileSync(join(OUT, name), Buffer.from(b64, 'base64')); console.log('  wrote', name); };

async function until(fn, label, maxMs = 600000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) { await sleep(3000); try { if (await page.evaluate(fn)) return true; } catch {} }
  throw new Error('timed out: ' + label);
}

// ---------------------------------------------------------------- data charts (drawn in-page)
// Drawn on a canvas in the browser so text renders with a real font engine, then exported as PNG.
async function charts() {
  console.log('data charts');
  const pngs = await page.evaluate(() => {
    const out = {};
    const C = { ink: '#12151c', mid: '#5b6472', grid: '#dfe3ea', bg: '#ffffff',
                a: '#2f6fb0', b: '#c2410c', c: '#3f8f5f', d: '#8b5cf6' };
    function mk(w, h) {
      const cv = document.createElement('canvas');
      cv.width = w * 2; cv.height = h * 2;
      const x = cv.getContext('2d'); x.scale(2, 2);
      x.fillStyle = C.bg; x.fillRect(0, 0, w, h);
      x.textBaseline = 'middle';
      return { cv, x, w, h };
    }
    const F = (x, s, weight = '400') => { x.font = `${weight} ${s}px "Segoe UI", Arial, sans-serif`; };

    // --- Figure: interface coverage (driven / read / interior) -------------------------------
    {
      const { cv, x, w, h } = mk(560, 200);
      const rows = [['Externally driven (sensory)', 74498, C.a], ['Read as output (motor)', 534, C.b], ['Interior', 90090, C.mid]];
      const max = 165122, L = 210, R = w - 90;
      F(x, 12);
      rows.forEach(([label, v, col], i) => {
        const y = 46 + i * 46;
        x.fillStyle = C.ink; x.textAlign = 'right'; x.fillText(label, L - 12, y);
        x.fillStyle = C.grid; x.fillRect(L, y - 11, R - L, 22);
        x.fillStyle = col; x.fillRect(L, y - 11, (R - L) * v / max, 22);
        x.fillStyle = C.ink; x.textAlign = 'left';
        x.fillText(`${v.toLocaleString()}  (${(100 * v / max).toFixed(1)}%)`, L + (R - L) * v / max + 8, y);
      });
      F(x, 11); x.fillStyle = C.mid; x.textAlign = 'left';
      x.fillText('N = 165,122 neurons. Bars are shares of the whole connectome.', L - 200, h - 22);
      out.coverage = cv.toDataURL('image/png').split(',')[1];
    }

    // --- Figure: soma availability by class --------------------------------------------------
    {
      const { cv, x, w, h } = mk(560, 320);
      const rows = [['olfactory', 2639, 0], ['gustatory', 1428, 0], ['thermosensory', 25, 0],
        ['hygrosensory', 66, 0], ['mechanosensory', 1733, 0], ['mechanosens. (tactile)', 2558, 0],
        ['unknown sensory', 1707, 0], ['visual', 4107, 28], ['Kenyon cell', 4064, 4050],
        ['dopaminergic', 340, 340], ['central complex', 2950, 2944]];
      const L = 165, R = w - 74;
      F(x, 11.5);
      rows.forEach(([label, tot, has], i) => {
        const y = 32 + i * 25, frac = has / tot;
        x.fillStyle = C.ink; x.textAlign = 'right'; x.fillText(label, L - 10, y);
        x.fillStyle = C.grid; x.fillRect(L, y - 8, R - L, 16);
        x.fillStyle = frac > 0.5 ? C.c : C.b; x.fillRect(L, y - 8, Math.max(frac * (R - L), frac > 0 ? 1.5 : 0), 16);
        x.fillStyle = C.mid; x.textAlign = 'left';
        x.fillText(`${(100 * frac).toFixed(1)}%`, R + 8, y);
      });
      F(x, 11); x.fillStyle = C.mid; x.textAlign = 'left';
      x.fillText('Share of each class with soma coordinates in the volume.', 8, h - 18);
      out.soma = cv.toDataURL('image/png').split(',')[1];
    }

    // --- Figure: the teaching signal, before and after the afferent --------------------------
    {
      const { cv, x, w, h } = mk(560, 250);
      const groups = [
        { t: 'Before: rest', v: 0.007, col: C.mid },
        { t: 'Before: punished', v: 0.111, col: C.b },
        { t: 'After: rest', v: -0.023, col: C.mid },
        { t: 'After: punished', v: 0.149, col: C.c },
      ];
      const baseY = 150, scale = 420, x0 = 80, bw = 74, gap = 42;
      // gate threshold line
      const gy = baseY - 0.15 * scale;
      x.strokeStyle = C.d; x.setLineDash([5, 4]); x.lineWidth = 1.5;
      x.beginPath(); x.moveTo(x0 - 20, gy); x.lineTo(w - 20, gy); x.stroke(); x.setLineDash([]);
      F(x, 11); x.fillStyle = C.d; x.textAlign = 'left'; x.fillText('gate threshold 0.15', x0 - 18, gy - 12);
      groups.forEach((g, i) => {
        const bx = x0 + i * (bw + gap), hgt = g.v * scale;
        x.fillStyle = g.col;
        x.fillRect(bx, hgt >= 0 ? baseY - hgt : baseY, bw, Math.abs(hgt));
        F(x, 12, '600'); x.fillStyle = C.ink; x.textAlign = 'center';
        x.fillText(g.v.toFixed(3), bx + bw / 2, (hgt >= 0 ? baseY - hgt : baseY + Math.abs(hgt)) + (hgt >= 0 ? -12 : 14));
        F(x, 10.5); x.fillStyle = C.mid;
        g.t.split(': ').forEach((ln, k) => x.fillText(ln, bx + bw / 2, baseY + 22 + k * 14));
      });
      x.strokeStyle = C.ink; x.lineWidth = 1;
      x.beginPath(); x.moveTo(x0 - 20, baseY); x.lineTo(w - 20, baseY); x.stroke();
      F(x, 11); x.fillStyle = C.mid; x.textAlign = 'left';
      x.fillText('Phasic dopamine (avRel). Only values above the dashed line open the gate.', 12, h - 16);
      out.teaching = cv.toDataURL('image/png').split(',')[1];
    }

    // --- Figure: architecture / four clocks --------------------------------------------------
    {
      const { cv, x, w, h } = mk(600, 300);
      const box = (bx, by, bw, bh, title, sub, col) => {
        x.fillStyle = col; x.globalAlpha = 0.10; x.fillRect(bx, by, bw, bh); x.globalAlpha = 1;
        x.strokeStyle = col; x.lineWidth = 1.5; x.strokeRect(bx, by, bw, bh);
        F(x, 12, '600'); x.fillStyle = C.ink; x.textAlign = 'center';
        x.fillText(title, bx + bw / 2, by + 20);
        F(x, 10.5); x.fillStyle = C.mid;
        sub.split('\n').forEach((s, i) => x.fillText(s, bx + bw / 2, by + 40 + i * 14));
      };
      const arrow = (x1, y1, x2, y2, label) => {
        x.strokeStyle = C.mid; x.lineWidth = 1.2; x.beginPath(); x.moveTo(x1, y1); x.lineTo(x2, y2); x.stroke();
        const a = Math.atan2(y2 - y1, x2 - x1);
        x.beginPath(); x.moveTo(x2, y2);
        x.lineTo(x2 - 7 * Math.cos(a - 0.4), y2 - 7 * Math.sin(a - 0.4));
        x.lineTo(x2 - 7 * Math.cos(a + 0.4), y2 - 7 * Math.sin(a + 0.4));
        x.closePath(); x.fillStyle = C.mid; x.fill();
        if (label) { F(x, 10); x.fillStyle = C.mid; x.textAlign = 'center'; x.fillText(label, (x1 + x2) / 2, (y1 + y2) / 2 - 7); }
      };
      box(20, 30, 150, 78, 'Physics', 'MuJoCo, flybody\n0.2 ms × 5', C.a);
      box(225, 30, 150, 78, 'Senses', 'transduction\n1 ms', C.c);
      box(430, 30, 150, 78, 'Optic lobe', 'flyvis, 721 cols/eye\n20 ms', C.d);
      box(225, 178, 150, 78, 'LIF brain', '165,122 neurons\n0.5 ms × 2', C.b);
      box(20, 178, 150, 78, 'Motor', 'descending / VNC\n1 ms', C.a);
      arrow(170, 69, 225, 69);
      arrow(430, 69, 375, 69);
      arrow(300, 108, 300, 178);
      arrow(225, 217, 170, 217);
      arrow(95, 178, 95, 108, 'closes the loop');
      F(x, 11); x.fillStyle = C.mid; x.textAlign = 'left';
      x.fillText('One shared connectome in SharedArrayBuffer; private dynamic state per animal.', 20, h - 18);
      out.arch = cv.toDataURL('image/png').split(',')[1];
    }
    return out;
  });
  for (const [k, v] of Object.entries(pngs)) save(`fig-${k}.png`, v);
}

// ---------------------------------------------------------------- real captures from the arena
async function captures() {
  console.log('\nloading the arena for real captures');
  await page.goto(`${BASE}/arena.html?flies=3&persist=0&ringmaster=0`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await until(() => !!window.__arena && window.__arena.flies.some(f => f.ready), 'arena ready');
  await page.evaluate(async () => {
    const a = window.__arena;
    while (a.flies.length < 3) { const k = a.flies.length, th = k * 2.1;
      await a.addFly([1.1 * Math.cos(th), 1.1 * Math.sin(th)], th); }
    document.querySelector('#play').click();
  });
  await sleep(9000);

  // the brain inset: the soma point cloud
  console.log('brain scans');
  const brain = await page.$('#brain');
  if (brain) save('fig-brain-soma.png', await brain.screenshot({ encoding: 'base64' }));

  // neural mapping: highlight one group at a time and capture the inset
  const maps = [
    ['Smell', 'smell'], ['Looming detectors', 'looming'], ['Grooming', 'grooming'], ['Walk forward', 'walk'],
  ];
  for (const [label, slug] of maps) {
    const ok = await page.evaluate(lbl => {
      const rows = [...document.querySelectorAll('#groups .g')];
      const r = rows.find(el => el.querySelector('.name').textContent.trim().startsWith(lbl));
      if (!r) return false;
      r.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      return true;
    }, label);
    if (!ok) { console.log('  (group not found:', label, ')'); continue; }
    await sleep(2500);
    if (brain) save(`fig-map-${slug}.png`, await brain.screenshot({ encoding: 'base64' }));
  }
  await page.evaluate(() => {
    const r = document.querySelector('#groups .g');
    r?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
  });

  // the per-fly neural stack
  const stack = await page.$('#stWrap');
  if (stack) { await sleep(2000); save('fig-stack.png', await stack.screenshot({ encoding: 'base64' })); }

  // what the eyes see
  const eyes = await page.$('#eyerows');
  if (eyes) save('fig-eyes.png', await eyes.screenshot({ encoding: 'base64' }));

  // the arena itself
  await page.evaluate(() => {
    const a = window.__arena;
    if (!document.querySelector('#panel').classList.contains('folded')) document.querySelector('#panelFold').click();
    if (!document.querySelector('#brainpanel').classList.contains('folded')) document.querySelector('#bpFold').click();
    document.querySelector('#follow').checked = false;
    a.camera.position.set(3.6, -3.6, 2.1); a.controls.target.set(0, 0, 0.45); a.controls.update();
  });
  await sleep(3000);
  save('fig-arena.png', await page.screenshot({ encoding: 'base64' }));
}

try {
  await page.goto('about:blank');
  await charts();
  await captures();
  console.log(`\nfigures written to ${OUT}`);
} finally {
  await browser.close();
}

import { defineConfig } from 'vite';
import { createHash } from 'crypto';
import fs from 'fs';
// Content hash + size of each packed data file: versioned URLs (cached forever by the decode worker)
// and exact download progress even when the host gzips the response.
const DATA_FILES = Object.fromEntries(['meta.json', 'neurons.flyn', 'graph.flyg', 'skeletons.flys'].map(f => {
  const b = fs.readFileSync(`public/data/${f}`);
  return [f, { v: createHash('sha1').update(b).digest('hex').slice(0, 10), size: b.length }];
}));
// Unpacked tables stay in public/data for the node scripts and Python pipeline but are not deployed.
const NOT_DEPLOYED = ['graph_w3.bin', 'neurons.bin'];
const dropUnpacked = { name: 'drop-unpacked-data', apply: 'build', closeBundle() { for (const f of NOT_DEPLOYED) fs.rmSync(`dist/data/${f}`, { force: true }); } };
// Cross-origin isolation enables SharedArrayBuffer (one read-only connectome shared by all fly workers)
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
export default defineConfig({
  base: process.env.BASE_PATH || '/', // CI sets /fly-brain/ for GitHub Pages
  plugins: [dropUnpacked],
  define: { __DATA_FILES__: JSON.stringify(DATA_FILES) },
  // DO NOT WATCH THE DATA DIRECTORIES.
  //
  // `study/` holds experiment output, not source: multi-megabyte JSON written repeatedly during a
  // run, plus whatever temporary files other programs leave there. Watching it is pure cost, and on
  // Windows it is worse than that -- the dev server was killed outright by
  //
  //     Error: EBUSY: resource busy or locked, watch 'study/mso415A.tmp'
  //
  // when Word created a lock file there while exporting a PDF. chokidar treats a watch error on any
  // single file as fatal to the whole watcher, so one transient lock in a directory vite has no
  // reason to care about takes the server down and the page stops loading.
  //
  // Anything written here that another program might hold open belongs outside the watch tree.
  // BIND THE IPv4 LOOPBACK EXPLICITLY.
  //
  // Left to itself the dev server bound only [::1], and anything that resolves `localhost` to
  // 127.0.0.1 -- headless Chrome among them -- got ERR_CONNECTION_REFUSED while curl, which
  // happened to prefer IPv6, saw HTTP 200. That is a confusing pair of symptoms: the server looks
  // up from the shell and dead from the browser.
  //
  // '127.0.0.1' is the loopback interface only. It is NOT `--host` / `true`, which would publish
  // the server on the local network; nothing here is reachable from another machine.
  server: {
    host: '127.0.0.1',
    headers: isolation,
    watch: { ignored: ['**/study/**', '**/bench/**.json', '**/*.tmp', '**/~$*'] },
  },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  worker: { format: 'es' },
  build: { target: 'esnext', rollupOptions: { input: { main: 'index.html', arena: 'arena.html', fly: 'fly.html', structures: 'structures.html', bench: 'bench.html', textbook: 'textbook/index.html' } } },
});

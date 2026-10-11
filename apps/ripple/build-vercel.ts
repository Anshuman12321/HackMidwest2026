import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const out = resolve(here('../../.vercel/output'));
const staticDir = resolve(out, 'static'), fn = resolve(out, 'functions/api.func');
await rm(out, { recursive: true, force: true });
await mkdir(staticDir, { recursive: true });
await mkdir(fn, { recursive: true });

// React app -> static
await build({ entryPoints: [here('web/app.tsx')], bundle: true, outfile: resolve(staticDir, 'app.js'), format: 'esm',
  jsx: 'automatic', minify: true, define: { 'process.env.NODE_ENV': '"production"' } });
await copyFile(here('web/index.html'), resolve(staticDir, 'index.html'));

// Hosted handler -> Node function (sharp stays external: only the PNG route imports it lazily)
await build({ entryPoints: [here('src/hosted-app.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: resolve(fn, 'index.mjs'), external: ['sharp'], logLevel: 'warning',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
await writeFile(resolve(fn, 'package.json'), JSON.stringify({ type: 'module' }));
await writeFile(resolve(fn, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs',
  launcherType: 'Nodejs', maxDuration: 60, supportsResponseStreaming: false }, null, 2));
// hosted-agent resolves <root>/imports/maple-payments/*, and root defaults to this directory at runtime.
await mkdir(resolve(fn, 'imports/maple-payments'), { recursive: true });
for (const name of ['manifest.json', 'data.zip']) await copyFile(here('../../imports/maple-payments/' + name), resolve(fn, 'imports/maple-payments', name));
// sharp is intentionally not bundled (platform-specific native module): the /graph/*.png route is unused by the React UI.

const toApi = (src: string) => ({ src, dest: '/api' });
await writeFile(resolve(out, 'config.json'), JSON.stringify({ version: 3, routes: [
  toApi('^/login$'), toApi('^/config$'), toApi('^/initialize$'), toApi('^/action$'), toApi('^/graph/(.*)$'), toApi('^/cron$'), toApi('^/native/status$'),
  { handle: 'filesystem' }, { src: '/(.*)', dest: '/index.html' },
] }, null, 2));
console.log('Vercel output written to ' + out);

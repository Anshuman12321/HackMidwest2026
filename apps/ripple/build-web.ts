import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
const root = new URL('./web/', import.meta.url);
const out = new URL('./web/build/', import.meta.url);
await mkdir(out, { recursive: true });
await build({ entryPoints: [new URL('app.tsx', root).pathname], bundle: true,
  outfile: new URL('app.js', out).pathname, format: 'esm', jsx: 'automatic',
  minify: true, sourcemap: false, define: { 'process.env.NODE_ENV': '"production"' } });
await copyFile(new URL('index.html', root), new URL('index.html', out));
console.log('Ripple React assets built.');

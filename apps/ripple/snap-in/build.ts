import { build } from 'esbuild';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('.', import.meta.url));
const out = fileURLToPath(new URL('./build/', import.meta.url));
const functions = ['ripple_initialize', 'ripple_action'];
await rm(out, { recursive: true, force: true });
await mkdir(out + 'dist/functions', { recursive: true });
// DevRev collects functions from dist/functions/<name>/index.js and loads dist/function-factory.js.
for (const name of functions) {
  await build({ entryPoints: [root + `src/functions/${name}/index.ts`], outfile: out + `dist/functions/${name}/index.js`,
    bundle: true, platform: 'node', target: 'node20', format: 'cjs', sourcemap: true });
}
await writeFile(out + 'dist/function-factory.js',
  'exports.functionFactory = { ' + functions.map((n) => `${n}: require('./functions/${n}').default`).join(', ') + ' };\n');
await writeFile(out + 'dist/index.js', "module.exports = require('./function-factory');\n");
const pkg = JSON.parse(await readFile(root + 'package.json', 'utf8'));
await writeFile(out + 'package.json', JSON.stringify({ ...pkg, type: 'commonjs' }, null, 2));
await cp(root + 'src', out + 'src', { recursive: true });
// Bundles carry runtime code; source is included for inspection, not runtime imports.
execFileSync('tar', ['-czf', root + 'build.tar.gz', '-C', out, 'dist', 'package.json', 'src']);
console.log('Built apps/ripple/snap-in/build.tar.gz');

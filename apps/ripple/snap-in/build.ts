import { build } from 'esbuild';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('.', import.meta.url));
const out = fileURLToPath(new URL('./build/', import.meta.url));
await mkdir(out + 'dist', { recursive: true });
await build({ entryPoints: [root + 'src/index.ts'], outfile: out + 'dist/index.js', bundle: true, platform: 'node',
  target: 'node20', format: 'cjs', sourcemap: true });
const pkg = JSON.parse(await readFile(root + 'package.json', 'utf8'));
await writeFile(out + 'package.json', JSON.stringify({ ...pkg, type: 'commonjs' }, null, 2));
await cp(root + 'src', out + 'src', { recursive: true });
// Bundle carries runtime code; source is included for inspection, not runtime imports.
execFileSync('tar', ['-czf', root + 'build.tar.gz', '-C', out, 'dist', 'package.json', 'src']);
console.log('Built apps/ripple/snap-in/build.tar.gz');

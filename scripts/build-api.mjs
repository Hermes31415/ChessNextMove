// Build the deployable Worker bundle:
//   npm run build:api   ->  api/dist/worker.mjs  (single-file ESM for Cloudflare)
//
// api/worker.js imports api/core.js which imports ../chess.min.js (a plain ESM
// module — verified: no UMD wrapper), so esbuild can bundle it with no shims.
import { mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'api', 'dist'), { recursive: true });

const out = join(root, 'api', 'dist', 'worker.mjs');
await build({
  entryPoints: [join(root, 'api', 'worker.js')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  legalComments: 'none',
  logLevel: 'warning'
});

console.log(`built api/dist/worker.mjs (${(statSync(out).size / 1024).toFixed(1)} kB)`);

// Runs src/core against a real repository and prints what the extension would show.
// Usage: npm run smoke -- <path-to-repo> [checkpoint-id]
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, '..', 'dist', 'smoke.mjs');

await esbuild.build({
  entryPoints: [path.join(here, 'smoke.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'warning',
});

const { main } = await import(pathToFileURL(outfile).href);
process.exitCode = await main(process.argv.slice(2));

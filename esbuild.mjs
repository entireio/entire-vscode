import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  target: 'es2022',
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const extension = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
  ...shared,
  entryPoints: { panel: 'src/webview/main.ts' },
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'iife',
  loader: { '.css': 'css' },
};

if (watch) {
  const contexts = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}

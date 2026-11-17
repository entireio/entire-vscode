// Writes THIRD_PARTY_NOTICES.md: the license of each npm package whose code is
// bundled into the files this extension ships. The list comes from the bundler,
// so it follows the code and cannot drift from a hand-kept list.
//
// Usage: node scripts/notices.mjs          write the file
//        node scripts/notices.mjs --check  fail if the file is out of date
import * as esbuild from 'esbuild';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'THIRD_PARTY_NOTICES.md');

// The same two bundles that esbuild.mjs builds.
const bundles = [
  { entryPoints: ['src/extension.ts'], platform: 'node', format: 'cjs', external: ['vscode'] },
  { entryPoints: ['src/webview/main.ts'], platform: 'browser', format: 'iife', loader: { '.css': 'css' } },
];

/** Package directory -> true, for every package that contributed a file to a bundle. */
const directories = new Set();
for (const bundle of bundles) {
  const result = await esbuild.build({
    ...bundle,
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    outdir: 'unused',
    logLevel: 'silent',
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const marker = 'node_modules/';
    const at = input.lastIndexOf(marker);
    if (at < 0) continue;
    const [first, second] = input.slice(at + marker.length).split('/');
    const name = first.startsWith('@') ? `${first}/${second}` : first;
    directories.add(path.join(root, input.slice(0, at + marker.length), name));
  }
}

const packages = [...directories]
  .map((directory) => {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const licenseFile = readdirSync(directory).find((file) => /^(licen[sc]e|copying)/i.test(file));
    const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
    return {
      name: manifest.name,
      version: manifest.version,
      license: typeof manifest.license === 'string' ? manifest.license : 'See the license text below',
      source: (manifest.homepage ?? repository ?? '').replace(/^git\+/, '').replace(/\.git$/, ''),
      text: licenseFile ? readFileSync(path.join(directory, licenseFile), 'utf8').trim() : undefined,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const missing = packages.filter((entry) => !entry.text).map((entry) => entry.name);
if (missing.length > 0) {
  console.error(`No license file found for: ${missing.join(', ')}. Add their license text by hand before shipping.`);
  process.exit(1);
}

const sections = packages.map((entry) =>
  [
    `## ${entry.name} ${entry.version}`,
    '',
    `License: ${entry.license}`,
    ...(entry.source ? ['', `Source: ${entry.source}`] : []),
    '',
    '```text',
    entry.text,
    '```',
  ].join('\n'),
);

const content = `${[
  '# Third-Party Notices',
  '',
  'The files this extension ships include code from the packages below. Each one is listed with its license.',
  '',
  ...sections.flatMap((section) => [section, '']),
]
  .join('\n')
  .trimEnd()}\n`;

if (process.argv.includes('--check')) {
  const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (current !== content) {
    console.error('THIRD_PARTY_NOTICES.md is out of date. Run "npm run notices" and commit the result.');
    process.exit(1);
  }
  console.log(`THIRD_PARTY_NOTICES.md is current (${packages.length} packages).`);
} else {
  writeFileSync(target, content);
  console.log(`Wrote THIRD_PARTY_NOTICES.md with ${packages.length} packages: ${packages.map((entry) => entry.name).join(', ')}.`);
}

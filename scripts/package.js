#!/usr/bin/env node
// Zips src/ into dist/zimu-<version>.zip (Chrome/Brave) and .xpi (Zen/Firefox).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const { version } = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
if (!fs.existsSync(path.join(SRC, 'data', 'cedict.u8'))) {
  console.error('src/data/cedict.u8 missing — run npm run build first');
  process.exit(1);
}

// Your own servers stay out of the repo: servers.local.json is a list of
// match patterns, added to the built manifest wherever localhost is allowed.
const OUT = path.join(ROOT, 'dist', 'unpacked');
fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SRC, OUT, { recursive: true });
const LOCAL = path.join(ROOT, 'servers.local.json');
if (fs.existsSync(LOCAL)) {
  const servers = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
  const file = path.join(OUT, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const allow = (list) => { if (list.includes('http://localhost/*')) list.unshift(...servers); };
  allow(manifest.host_permissions);
  for (const entry of [...manifest.content_scripts, ...manifest.web_accessible_resources]) allow(entry.matches);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`added ${servers.length} server(s) from servers.local.json`);
}
for (const ext of ['zip', 'xpi']) {
  const out = path.join(ROOT, 'dist', `zimu-${version}.${ext}`);
  fs.rmSync(out, { force: true });
  execFileSync('zip', ['-qr', '-X', out, '.', '-x', '.*'], { cwd: OUT });
  console.log(path.relative(ROOT, out));
}

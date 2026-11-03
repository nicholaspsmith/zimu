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
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
for (const ext of ['zip', 'xpi']) {
  const out = path.join(ROOT, 'dist', `zimu-${version}.${ext}`);
  fs.rmSync(out, { force: true });
  execFileSync('zip', ['-qr', '-X', out, '.', '-x', '.*'], { cwd: SRC });
  console.log(path.relative(ROOT, out));
}

#!/usr/bin/env node
// Fetches CC-CEDICT and vendors pinyin-pro into src/ so the folder can be
// loaded as an unpacked extension. Run: npm run build [-- --refresh]
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const CEDICT_URL = 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz';
const CACHE = path.join(ROOT, 'data', 'cedict.txt.gz');
const OUT_DICT = path.join(ROOT, 'src', 'data', 'cedict.u8');
const OUT_PINYIN = path.join(ROOT, 'src', 'vendor', 'pinyin-pro.js');

async function main() {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_DICT), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_PINYIN), { recursive: true });

  if (!fs.existsSync(CACHE) || process.argv.includes('--refresh')) {
    console.log('downloading CC-CEDICT…');
    const res = await fetch(CEDICT_URL);
    if (!res.ok) throw new Error(`CC-CEDICT download failed: ${res.status}`);
    fs.writeFileSync(CACHE, Buffer.from(await res.arrayBuffer()));
  }
  const text = zlib.gunzipSync(fs.readFileSync(CACHE)).toString('utf8');
  const header = text.split('\n').filter((l) => l.startsWith('#'));
  const body = text.split('\n').filter((l) => l && !l.startsWith('#'));
  const date = (header.find((l) => l.startsWith('#! date=')) || '').slice(8);
  fs.writeFileSync(OUT_DICT, `# CC-CEDICT ${date} (CC BY-SA 4.0, https://www.mdbg.net/chinese/dictionary?page=cc-cedict)\n` + body.join('\n') + '\n');
  console.log(`cedict: ${body.length} entries → ${path.relative(ROOT, OUT_DICT)}`);

  const pp = require.resolve('pinyin-pro/dist/index.js');
  const ver = require('pinyin-pro/package.json').version;
  fs.writeFileSync(OUT_PINYIN, `/* pinyin-pro ${ver} (MIT) https://github.com/zh-lx/pinyin-pro */\n` + fs.readFileSync(pp, 'utf8'));
  console.log(`pinyin-pro ${ver} → ${path.relative(ROOT, OUT_PINYIN)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

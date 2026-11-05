'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Z = require('../src/lib/core.js');
require('../src/lib/dict.js');

test('numbered pinyin becomes tone marks', () => {
  assert.equal(Z.numberedToMarked('zhong1 guo2'), 'zhōngguó');
  assert.equal(Z.numberedToMarked('lu:4'), 'lǜ');
  assert.equal(Z.numberedToMarked('nu:3 er2'), 'nǚér');
  assert.equal(Z.numberedToMarked('xiu1'), 'xiū');
  assert.equal(Z.numberedToMarked('gui4'), 'guì');
  assert.equal(Z.numberedToMarked('dou1'), 'dōu');
  assert.equal(Z.numberedToMarked('le5'), 'le');
  assert.equal(Z.numberedToMarked('Bei3 jing1'), 'Běijīng');
  assert.equal(Z.numberedToMarked('Ou1 zhou1'), 'Ōuzhōu');
  assert.equal(Z.numberedToMarked('san1 D', ' '), 'sān D');
});

test('tone of a marked syllable', () => {
  assert.equal(Z.toneOf('mā'), 1);
  assert.equal(Z.toneOf('lǜ'), 4);
  assert.equal(Z.toneOf('ma'), 5);
});

test('cue text cleaning and bilingual split', () => {
  assert.equal(Z.cleanCueText('{\\an8}<i>你好</i>\\NHello &amp; bye'), '你好\nHello & bye');
  assert.equal(Z.cleanCueText('第一行<br/>第二行\r\n'), '第一行\n第二行');
  assert.deepEqual(Z.splitBilingual('你好吗\nHow are you?'), { zh: '你好吗', en: 'How are you?' });
  assert.deepEqual(Z.splitBilingual('……\n好'), { zh: '好', en: '' });
});

test('Jellyfin track events become sorted, merged cues', () => {
  const cues = Z.cuesFromJellyfin({ TrackEvents: [
    { StartPositionTicks: 30000000, EndPositionTicks: 50000000, Text: 'b' },
    { StartPositionTicks: 10000000, EndPositionTicks: 20000000, Text: 'a' },
    { StartPositionTicks: 10000000, EndPositionTicks: 20000000, Text: 'a2' },
    { StartPositionTicks: 60000000, EndPositionTicks: 70000000, Text: '{\\pos(1,2)}' },
  ] });
  assert.deepEqual(cues, [{ start: 1, end: 2, text: 'a\na2' }, { start: 3, end: 5, text: 'b' }]);
  assert.equal(Z.activeIndex(cues, 0.5), -1);
  assert.equal(Z.activeIndex(cues, 1.5), 0);
  assert.equal(Z.activeIndex(cues, 2.5), -1);
  assert.equal(Z.activeIndex(cues, 4), 1);
  assert.equal(Z.lastStartedIndex(cues, 2.5), 0);
});

test('english cue pairing by overlap', () => {
  const en = [
    { start: 0.9, end: 2.1, text: 'Hello.' },
    { start: 2.0, end: 3.0, text: 'Barely overlapping' },
    { start: 5, end: 6, text: 'Later' },
  ];
  assert.equal(Z.overlappingText(en, 1, 2.05), 'Hello.');
  assert.equal(Z.overlappingText(en, 4, 4.5), '');
});

test('segmentation keeps text intact and finds words', () => {
  const words = new Set(['我们', '今天', '天气', '很好', '研究', '研究生', '生命', '起源', '的']);
  const has = (w) => words.has(w);
  const toks = Z.segment('我们今天, OK 研究生命的起源。', has);
  assert.equal(toks.map((t) => t.text).join(''), '我们今天, OK 研究生命的起源。');
  assert.deepEqual(toks.filter((t) => t.han).map((t) => t.text), ['我们', '今天', '研究', '生命', '的', '起源']);
});

test('leitner scheduling', () => {
  const now = 1_000_000;
  assert.deepEqual(Z.schedule({ box: 3 }, 'again', now), { box: 0, due: now + 600000 });
  assert.equal(Z.schedule({ box: 0 }, 'good', now).box, 1);
  assert.equal(Z.schedule({ box: 0 }, 'easy', now).box, 2);
  assert.equal(Z.schedule({ box: 6 }, 'good', now).box, 6);
  assert.ok(Z.isDue({ due: now }, now));
});

test('clip url round trip', () => {
  const src = { server: 'http://jellyfin-host:8096', itemId: 'abc123', start: 61.5, end: 64.25 };
  const url = Z.clipUrl(src);
  assert.equal(url, 'http://jellyfin-host:8096/web/#/details?id=abc123&zimuStart=61.10&zimuEnd=64.25');
  assert.deepEqual(Z.parseClipHash(new URL(url).hash), { itemId: 'abc123', start: 61.1, end: 64.25 });
  assert.equal(Z.parseClipHash('#/details?id=abc'), null);
});

test('real CC-CEDICT: lookup and segmentation', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'cedict.u8'), 'utf8');
  const d = new Z.Dict(text);
  const zhong = d.lookup('中国');
  assert.equal(zhong[0].pinyin, 'Zhōngguó');
  assert.ok(d.lookup('學習')[0].defs.some((x) => /learn|study/.test(x)));
  // everyday sense of 了 comes before anything marked as a variant/surname
  const le = d.lookup('了');
  assert.ok(le.length >= 2);
  const seg = Z.segment('我觉得他还没睡着。', (w) => d.has(w), d.maxLen)
    .filter((t) => t.han).map((t) => t.text);
  assert.deepEqual(seg, ['我', '觉得', '他', '还', '没', '睡着']);
});

test('manifest runs on a local Jellyfin', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'manifest.json'), 'utf8'));
  const servers = ['http://localhost:8096/web/', 'http://127.0.0.1:8096/web/'];
  const covers = (patterns, url) => patterns.some((p) => {
    const [, scheme, host] = /^(\*|https?):\/\/([^/]+)\//.exec(p);
    const u = new URL(url);
    return (scheme === '*' || scheme + ':' === u.protocol) && host === u.hostname;
  });
  for (const url of servers) {
    assert.ok(covers(m.content_scripts[0].matches, url), `content script misses ${url}`);
    assert.ok(covers(m.host_permissions, url), `host permission misses ${url}`);
    assert.ok(covers(m.web_accessible_resources[0].matches, url), `dictionary not accessible on ${url}`);
  }
});

test('estimating when a word is spoken inside a line', () => {
  const text = '我们一起学习中文吧';
  const w = Z.estimateSpan(text, 4, 6, 10, 19.6); // 学习
  // speech assumed from 10.2 to 19.25, one syllable ≈ 1.006 s
  assert.ok(Math.abs(w.start - 14.22) < 0.02, String(w.start));
  assert.ok(Math.abs(w.end - 16.23) < 0.02, String(w.end));
  // first and last words touch the speech window's edges
  assert.ok(Math.abs(Z.estimateSpan(text, 0, 2, 10, 19.6).start - 10.2) < 1e-9);
  assert.ok(Math.abs(Z.estimateSpan(text, 8, 9, 10, 19.6).end - 19.25) < 1e-9);
  // a pause (comma) takes time, pushing later words back
  const withComma = Z.estimateSpan('好的，我们走吧', 3, 5, 0, 4);
  const without = Z.estimateSpan('好的我们走吧', 2, 4, 0, 4);
  assert.ok(withComma.start > without.start);
  // offsets count code points, not UTF-16 units
  const astral = Z.estimateSpan('𠮷我们', 1, 3, 0, 3);
  assert.ok(astral.start > 0.5 && astral.end <= 3);
});

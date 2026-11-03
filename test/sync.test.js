'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Z = require('../src/lib/sync.js');

const DAY = 24 * 3600 * 1000;
const NOW = 1_800_000_000_000;
const card = (hanzi, updated, extra = {}) => ({ id: hanzi, hanzi, created: 1, updated, ...extra });

test('union of both sides', () => {
  const m = Z.Sync.merge(
    { records: { 'c:吃饭': card('吃饭', 10) }, deleted: {} },
    { records: { 'c:学习': card('学习', 20) }, deleted: {} }, NOW);
  assert.deepEqual(Object.keys(m.records).sort(), ['c:吃饭', 'c:学习']);
});

test('newer edit wins (review progress made on the other Mac)', () => {
  const m = Z.Sync.merge(
    { records: { 'c:吃饭': card('吃饭', 10, { box: 1 }) }, deleted: {} },
    { records: { 'c:吃饭': card('吃饭', 30, { box: 3 }) }, deleted: {} }, NOW);
  assert.equal(m.records['c:吃饭'].box, 3);
});

test('a deletion removes older copies but not a later re-add', () => {
  const del = Z.Sync.merge(
    { records: { 's:abc': { key: 'abc', created: 5 } }, deleted: {} },
    { records: {}, deleted: { 's:abc': NOW - DAY } }, NOW);
  assert.equal(del.records['s:abc'], undefined);
  assert.equal(del.deleted['s:abc'], NOW - DAY);
  const readd = Z.Sync.merge(
    { records: { 'c:吃饭': card('吃饭', NOW) }, deleted: {} },
    { records: {}, deleted: { 'c:吃饭': NOW - DAY } }, NOW);
  assert.ok(readd.records['c:吃饭']);
  assert.equal(readd.deleted['c:吃饭'], undefined);
});

test('old tombstones are forgotten', () => {
  const m = Z.Sync.merge({ records: {}, deleted: { 'c:x': NOW - 200 * DAY } }, { records: {}, deleted: {} }, NOW);
  assert.deepEqual(m.deleted, {});
});

test('records without `updated` fall back to created / reviewed', () => {
  assert.equal(Z.Sync.updatedOf({ created: 5, reviewed: 9 }), 9);
  assert.equal(Z.Sync.updatedOf({ created: 5 }), 5);
  assert.equal(Z.Sync.updatedOf({ created: 5, updated: 7 }), 7);
});

test('ties resolve the same way on both machines', () => {
  const a = card('好', 10, { box: 1 });
  const b = card('好', 10, { box: 2 });
  const ab = Z.Sync.merge({ records: { 'c:好': a }, deleted: {} }, { records: { 'c:好': b }, deleted: {} }, NOW);
  const ba = Z.Sync.merge({ records: { 'c:好': b }, deleted: {} }, { records: { 'c:好': a }, deleted: {} }, NOW);
  assert.deepEqual(ab.records['c:好'], ba.records['c:好']);
});

test('prefs round trip and comparison', () => {
  const state = { records: { 'c:吃饭': card('吃饭', 10), 's:abc': { key: 'abc', explanation: '**Literal**', created: 3 } }, deleted: { 'c:旧': 99 } };
  const prefs = Z.Sync.toPrefs(state);
  assert.equal(prefs['d:c:旧'], '99');
  assert.deepEqual(Z.Sync.fromPrefs({ ...prefs, homesections0: 'x', 'c:bad': '{' }), state);
  assert.ok(Z.Sync.samePrefs(prefs, { ...prefs }));
  assert.ok(!Z.Sync.samePrefs(prefs, { ...prefs, 'd:c:新': '1' }));
});

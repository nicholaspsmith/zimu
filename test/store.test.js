'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

let stored = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => ({ [k]: stored[k] }),
  set: async (o) => { Object.assign(stored, o); },
} } };
require('../src/lib/store.js');
const { Settings, DEFAULT_SETTINGS } = globalThis.Zimu;

test('subtitles default to just above the control bar', async () => {
  stored = {};
  assert.equal((await Settings.get()).bottom, 1);
  assert.equal(DEFAULT_SETTINGS.bottom, 1);
});

test('a height saved before it was measured from the bar moves to the default', async () => {
  for (const schema of [2, 3]) {
    stored = { settings: { schema, bottom: 20, speed: 90 } };
    const s = await Settings.get();
    assert.equal(s.bottom, 1);
    assert.equal(s.speed, 90);
    assert.equal(stored.settings.schema, DEFAULT_SETTINGS.schema);
  }
});

test('a height chosen since then is kept', async () => {
  stored = { settings: { schema: DEFAULT_SETTINGS.schema, bottom: 12 } };
  assert.equal((await Settings.get()).bottom, 12);
});

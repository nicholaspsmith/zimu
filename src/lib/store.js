// Settings and flashcards in extension storage (shared by the overlay and
// the flashcard page).
(function (root) {
  'use strict';
  const Z = root.Zimu || (root.Zimu = {});
  const area = () => chrome.storage.local;

  const SCHEMA = 4;
  const DEFAULT_SETTINGS = {
    schema: SCHEMA,
    showHanzi: true,
    showPinyin: true,
    showEnglish: true,
    showGloss: false, // a short meaning under each word, pinyin-sized
    fontSize: 34, // px for hanzi
    textOpacity: 100, // % — subtitle text
    bgOpacity: 75, // % — the box behind the subtitles
    bottom: 1, // % of the window height above Jellyfin's controls
    pauseOnHover: false,
    playWordOnClick: true, // clicking a word plays it from the video
    explainOnHover: true, // Claude explains the line when the box (not a word) is clicked
    speed: 100, // playback speed in %, 40-100
    hideNativeSubs: true,
    toneColors: false,
    machineTranslate: true, // when no English subtitle track exists
    offShows: [], // series (or film) ids Zimu is switched off for, newest last
  };

  const Settings = {
    async get() {
      const r = await area().get('settings');
      const stored = r.settings || {};
      const schema = stored.schema || 1;
      if (schema < SCHEMA) {
        // 0.2.0: hovering the subtitles no longer pauses by default
        if (schema < 2) stored.pauseOnHover = false;
        // 0.10.0: height now counts from the top of Jellyfin's controls, so
        // a saved height would sit far too high
        delete stored.bottom;
        stored.schema = SCHEMA;
        await area().set({ settings: stored });
      }
      return { ...DEFAULT_SETTINGS, ...stored };
    },
    async set(patch) {
      const s = { ...(await Settings.get()), ...patch };
      await area().set({ settings: s });
      return s;
    },
  };

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // Deletions are remembered (key → time) so they reach the other Mac.
  async function tombstone(key) {
    const { deleted = {} } = await area().get('deleted');
    deleted[key] = Date.now();
    await area().set({ deleted });
  }

  const Cards = {
    async all() {
      const r = await area().get('cards');
      return r.cards || [];
    },
    async replaceAll(cards) {
      await area().set({ cards });
    },
    // One card per headword: saving an existing word returns the old card.
    async add(card) {
      const cards = await Cards.all();
      const existing = cards.find((c) => c.hanzi === card.hanzi);
      if (existing) return existing;
      const now = Date.now();
      const full = { id: newId(), created: now, box: 0, due: now, ...card, updated: now };
      cards.push(full);
      await Cards.replaceAll(cards);
      return full;
    },
    async update(id, patch) {
      const cards = await Cards.all();
      const i = cards.findIndex((c) => c.id === id);
      if (i < 0) return null;
      cards[i] = { ...cards[i], ...patch, updated: Date.now() };
      await Cards.replaceAll(cards);
      return cards[i];
    },
    async removeByHanzi(hanzi) {
      await Cards.replaceAll((await Cards.all()).filter((c) => c.hanzi !== hanzi));
      await tombstone(`c:${hanzi}`);
    },
    async remove(id) {
      const cards = await Cards.all();
      const gone = cards.find((c) => c.id === id);
      await Cards.replaceAll(cards.filter((c) => c.id !== id));
      if (gone) await tombstone(`c:${gone.hanzi}`);
    },
    onChange(cb) {
      chrome.storage.onChanged.addListener((changes, name) => {
        if (name === 'local' && changes.cards) cb(changes.cards.newValue || []);
      });
    },
  };

  // Explained lines, saved by the background script under "s:<hash>".
  const Sentences = {
    async all() {
      const everything = await area().get(null);
      return Object.entries(everything)
        .filter(([k]) => k.startsWith('s:'))
        .map(([, v]) => v)
        .sort((a, b) => (b.created || 0) - (a.created || 0));
    },
    async get(key) {
      const r = await area().get(`s:${key}`);
      return r[`s:${key}`] || null;
    },
    // × on the overlay: don't bring this one back on its own any more.
    async setDismissed(key, dismissed) {
      const rec = await Sentences.get(key);
      if (!rec || !!rec.dismissed === dismissed) return;
      await area().set({ [`s:${key}`]: { ...rec, dismissed, updated: Date.now() } });
    },
    // Review progress and the like; stamps `updated` so it syncs.
    async update(key, patch) {
      const rec = await Sentences.get(key);
      if (!rec) return null;
      const next = { ...rec, ...patch, updated: Date.now() };
      await area().set({ [`s:${key}`]: next });
      return next;
    },
    async remove(key) {
      await area().remove(`s:${key}`);
      await tombstone(`s:${key}`);
    },
    onChange(cb) {
      chrome.storage.onChanged.addListener((changes, name) => {
        if (name === 'local' && Object.keys(changes).some((k) => k.startsWith('s:'))) cb();
      });
    },
  };

  Object.assign(Z, { DEFAULT_SETTINGS, Settings, Cards, Sentences });
})(typeof globalThis !== 'undefined' ? globalThis : this);

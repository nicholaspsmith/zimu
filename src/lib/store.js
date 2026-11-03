// Settings and flashcards in extension storage (shared by the overlay and
// the flashcard page).
(function (root) {
  'use strict';
  const Z = root.Zimu || (root.Zimu = {});
  const area = () => chrome.storage.local;

  const SCHEMA = 2;
  const DEFAULT_SETTINGS = {
    schema: SCHEMA,
    showHanzi: true,
    showPinyin: true,
    showEnglish: true,
    fontSize: 34, // px for hanzi
    bottom: 12, // % of the window height
    autoPause: false, // pause at the end of every line
    pauseOnHover: false,
    playWordOnClick: true, // clicking a word plays it from the video
    explainOnHover: true, // Claude explains the line when hovering the box
    speed: 100, // playback speed in %, 60-100
    hideNativeSubs: true,
    toneColors: false,
    machineTranslate: true, // when no English subtitle track exists
  };

  const Settings = {
    async get() {
      const r = await area().get('settings');
      const stored = r.settings || {};
      if ((stored.schema || 1) < 2) {
        // 0.2.0: hovering the subtitles no longer pauses by default
        stored.pauseOnHover = false;
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
      const full = { id: newId(), created: Date.now(), box: 0, due: Date.now(), ...card };
      cards.push(full);
      await Cards.replaceAll(cards);
      return full;
    },
    async update(id, patch) {
      const cards = await Cards.all();
      const i = cards.findIndex((c) => c.id === id);
      if (i < 0) return null;
      cards[i] = { ...cards[i], ...patch };
      await Cards.replaceAll(cards);
      return cards[i];
    },
    async removeByHanzi(hanzi) {
      await Cards.replaceAll((await Cards.all()).filter((c) => c.hanzi !== hanzi));
    },
    async remove(id) {
      await Cards.replaceAll((await Cards.all()).filter((c) => c.id !== id));
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
    async has(key) {
      const r = await area().get(`s:${key}`);
      return !!r[`s:${key}`];
    },
    async remove(key) {
      await area().remove(`s:${key}`);
    },
    onChange(cb) {
      chrome.storage.onChanged.addListener((changes, name) => {
        if (name === 'local' && Object.keys(changes).some((k) => k.startsWith('s:'))) cb();
      });
    },
  };

  Object.assign(Z, { DEFAULT_SETTINGS, Settings, Cards, Sentences });
})(typeof globalThis !== 'undefined' ? globalThis : this);

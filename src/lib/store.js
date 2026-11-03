// Settings and flashcards in extension storage (shared by the overlay and
// the flashcard page).
(function (root) {
  'use strict';
  const Z = root.Zimu || (root.Zimu = {});
  const area = () => chrome.storage.local;

  const DEFAULT_SETTINGS = {
    showHanzi: true,
    showPinyin: true,
    showEnglish: true,
    fontSize: 34, // px for hanzi
    bottom: 12, // % of the window height
    autoPause: false, // pause at the end of every line
    pauseOnHover: true,
    hideNativeSubs: true,
    toneColors: false,
    machineTranslate: true, // when no English subtitle track exists
  };

  const Settings = {
    async get() {
      const r = await area().get('settings');
      return { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
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

  Object.assign(Z, { DEFAULT_SETTINGS, Settings, Cards });
})(typeof globalThis !== 'undefined' ? globalThis : this);

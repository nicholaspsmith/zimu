// CC-CEDICT lookup. Keeps the raw lines and an index from headword
// (traditional and simplified) to line numbers; entries are parsed lazily.
(function (root) {
  'use strict';
  const Z = root.Zimu || (root.Zimu = {});
  const LINE = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/;
  const MAX_INDEXED_LEN = 12;

  class Dict {
    constructor(text) {
      this.lines = text.split('\n');
      this.index = new Map();
      this.maxLen = 1;
      for (let i = 0; i < this.lines.length; i++) {
        const line = this.lines[i];
        if (!line || line[0] === '#') continue;
        const a = line.indexOf(' ');
        const b = line.indexOf(' ', a + 1);
        if (a < 0 || b < 0) continue;
        const trad = line.slice(0, a);
        const simp = line.slice(a + 1, b);
        this._add(trad, i);
        if (simp !== trad) this._add(simp, i);
      }
    }

    _add(word, i) {
      const len = Array.from(word).length;
      if (len > MAX_INDEXED_LEN) return;
      if (len > this.maxLen) this.maxLen = len;
      const list = this.index.get(word);
      if (list) list.push(i); else this.index.set(word, [i]);
    }

    has(word) {
      return this.index.has(word);
    }

    // Entries for a headword, everyday senses first: proper nouns,
    // surnames and "variant of" entries go last.
    lookup(word) {
      const ids = this.index.get(word) || [];
      const entries = [];
      for (const i of ids) {
        const m = LINE.exec(this.lines[i]);
        if (!m) continue;
        const defs = m[4].split('/').filter(Boolean);
        entries.push({
          trad: m[1],
          simp: m[2],
          reading: m[3],
          pinyin: Z.numberedToMarked(m[3]),
          defs,
        });
      }
      const rank = (e) => {
        let r = 0;
        if (/^[A-Z]/.test(e.reading)) r += 2;
        if (e.defs.every((d) => /^(surname |(old |archaic )?variant of |see |used in )/.test(d))) r += 1;
        return r;
      };
      return entries
        .map((e, i) => ({ e, i, r: rank(e) }))
        .sort((x, y) => x.r - y.r || x.i - y.i)
        .map((x) => x.e);
    }
  }

  Z.Dict = Dict;
  if (typeof module !== 'undefined' && module.exports) module.exports = Z;
})(typeof globalThis !== 'undefined' ? globalThis : this);

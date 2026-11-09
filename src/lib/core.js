// Pure helpers shared by the content script, the flashcard page and the tests.
// Loaded as a classic script (sets globalThis.Zimu) and as a CommonJS module.
(function (root) {
  'use strict';
  const Z = root.Zimu || (root.Zimu = {});

  const HAN = /\p{Script=Han}/u;
  const hasHan = (s) => HAN.test(s);

  // ---- pinyin -------------------------------------------------------------

  const MARKS = {
    a: 'āáǎà', e: 'ēéěè', i: 'īíǐì', o: 'ōóǒò', u: 'ūúǔù', 'ü': 'ǖǘǚǜ',
  };

  // "zhong1" -> "zhōng", "lu:4" -> "lǜ", "le5" -> "le". Anything else is
  // returned unchanged (apart from u: -> ü).
  function syllableToMarked(syl) {
    const m = /^([A-Za-zü:]+?)([1-5])$/.exec(syl);
    const body = (m ? m[1] : syl).replace(/u:/g, 'ü').replace(/U:/g, 'Ü');
    if (!m) return body;
    const tone = Number(m[2]);
    if (tone === 5) return body;
    const lower = body.toLowerCase();
    let idx = -1;
    if (lower.includes('a')) idx = lower.indexOf('a');
    else if (lower.includes('e')) idx = lower.indexOf('e');
    else if (lower.includes('ou')) idx = lower.indexOf('o');
    else {
      for (let i = lower.length - 1; i >= 0; i--) {
        if ('iouü'.includes(lower[i])) { idx = i; break; }
      }
    }
    if (idx < 0) return body;
    const vowel = lower[idx];
    let marked = MARKS[vowel][tone - 1];
    if (body[idx] !== vowel) marked = marked.toUpperCase();
    return body.slice(0, idx) + marked + body.slice(idx + 1);
  }

  // CC-CEDICT reading -> tone-marked pinyin. Syllables of one word are joined
  // ("zhong1 guo2" -> "zhōngguó"); letters/digits stay spaced.
  function numberedToMarked(reading, joiner = '') {
    return reading.trim().split(/\s+/).map(syllableToMarked).join(joiner);
  }

  // Tone number (1-5) of a tone-marked syllable, 5 for neutral.
  function toneOf(markedSyllable) {
    for (const ch of markedSyllable.normalize('NFC')) {
      for (const [, marks] of Object.entries(MARKS)) {
        const i = marks.indexOf(ch.toLowerCase());
        if (i >= 0) return i + 1;
      }
    }
    return 5;
  }

  // ---- subtitle text ------------------------------------------------------

  function decodeEntities(s) {
    return s
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  // Strips ASS override tags, HTML tags and ASS line breaks; returns the
  // non-empty trimmed lines joined by "\n".
  function cleanCueText(raw) {
    const s = String(raw || '')
      .replace(/\{[^}]*\}/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
      .replace(/\r/g, '');
    return decodeEntities(s)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');
  }

  // Many Chinese releases put both languages in one cue ("你好\nHello").
  // Lines containing Han characters are Chinese; lines with Latin letters
  // and no Han are English.
  function splitBilingual(text) {
    const zh = [];
    const en = [];
    for (const line of String(text || '').split('\n')) {
      if (!line) continue;
      if (hasHan(line)) zh.push(line);
      else if (/[A-Za-z]/.test(line)) en.push(line);
    }
    return { zh: zh.join('\n'), en: en.join(' ') };
  }

  // Jellyfin "Stream.js" payload -> [{start, end, text}] in seconds, sorted.
  function cuesFromJellyfin(json) {
    const events = (json && (json.TrackEvents || json.trackEvents)) || [];
    const cues = [];
    for (const ev of events) {
      const text = cleanCueText(ev.Text ?? ev.text);
      if (!text) continue;
      const start = Number(ev.StartPositionTicks ?? ev.startPositionTicks) / 1e7;
      const end = Number(ev.EndPositionTicks ?? ev.endPositionTicks) / 1e7;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      cues.push({ start, end: Math.max(end, start + 0.1), text });
    }
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    return mergeSimultaneous(cues);
  }

  // ASS tracks often split one moment into several events with identical
  // times; merge those so a "line" is one cue.
  function mergeSimultaneous(cues) {
    const out = [];
    for (const c of cues) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.start - c.start) < 0.01 && Math.abs(last.end - c.end) < 0.01) {
        if (!last.text.split('\n').includes(c.text)) last.text += '\n' + c.text;
      } else {
        out.push({ ...c });
      }
    }
    return out;
  }

  // Index of the last cue starting at or before t, or -1.
  function lastStartedIndex(cues, t) {
    let lo = 0;
    let hi = cues.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // Index of the cue showing at time t (latest-starting one if several
  // overlap), or -1.
  function activeIndex(cues, t) {
    const i = lastStartedIndex(cues, t);
    for (let j = i; j >= 0 && j > i - 8; j--) {
      if (cues[j].end > t) return j;
    }
    return -1;
  }

  // Text of the cues in `others` overlapping [start, end] by at least 30% of
  // the shorter one; used to pair an English cue with a Chinese one.
  function overlappingText(others, start, end) {
    if (!others || !others.length) return '';
    const parts = [];
    let i = Math.max(0, lastStartedIndex(others, start) - 4);
    for (; i < others.length && others[i].start < end; i++) {
      const o = others[i];
      const overlap = Math.min(end, o.end) - Math.max(start, o.start);
      const shorter = Math.min(end - start, o.end - o.start);
      if (overlap > 0 && overlap >= 0.3 * shorter) parts.push(o.text.replace(/\n/g, ' '));
    }
    return parts.join(' ');
  }

  // ---- segmentation -------------------------------------------------------

  function maxMatch(chars, has, maxLen, backward) {
    const out = [];
    if (!backward) {
      let i = 0;
      while (i < chars.length) {
        let len = Math.min(maxLen, chars.length - i);
        while (len > 1 && !has(chars.slice(i, i + len).join(''))) len--;
        out.push(chars.slice(i, i + len).join(''));
        i += len;
      }
    } else {
      let j = chars.length;
      while (j > 0) {
        let len = Math.min(maxLen, j);
        while (len > 1 && !has(chars.slice(j - len, j).join(''))) len--;
        out.unshift(chars.slice(j - len, j).join(''));
        j -= len;
      }
    }
    return out;
  }

  // Bidirectional maximum matching over a run of Han characters: fewer
  // words wins, then fewer single characters, then the backward result.
  function segmentHanRun(run, has, maxLen) {
    const chars = Array.from(run);
    const f = maxMatch(chars, has, maxLen, false);
    const b = maxMatch(chars, has, maxLen, true);
    if (f.length !== b.length) return f.length < b.length ? f : b;
    const singles = (ws) => ws.filter((w) => Array.from(w).length === 1).length;
    return singles(f) < singles(b) ? f : b;
  }

  // Splits text into tokens: {text, han}. Han runs are segmented into
  // dictionary words; everything else (punctuation, Latin, spaces) is kept
  // as its own token so the line can be rebuilt exactly.
  function segment(text, has, maxLen = 8) {
    const tokens = [];
    const re = /(\p{Script=Han}+)|([^\p{Script=Han}]+)/gu;
    let m;
    while ((m = re.exec(text))) {
      if (m[1]) {
        for (const w of segmentHanRun(m[1], has, maxLen)) tokens.push({ text: w, han: true });
      } else {
        tokens.push({ text: m[2], han: false });
      }
    }
    return tokens;
  }

  // ---- word timing ---------------------------------------------------------

  // Roughly how long each character takes to say, in syllables. Mandarin is
  // close to syllable-timed, so a line's speech is shared out by these.
  function speechWeight(ch) {
    if (HAN.test(ch) || /[0-9０-９]/.test(ch)) return 1;
    if (ch === '\n' || /[，、；：,;:]/.test(ch)) return 0.5;
    if (/[。！？!?…—]/.test(ch)) return 0.7;
    if (/[A-Za-z]/.test(ch)) return 0.3;
    if (/\s/.test(ch)) return 0.15;
    return 0;
  }

  // Estimated [start, end] (seconds) of the speech for code points
  // [from, to) of a cue's text. Subtitles usually appear a little before the
  // voice and linger after it, so the speech window is trimmed first.
  function estimateSpan(text, from, to, cueStart, cueEnd) {
    const chars = Array.from(text);
    const dur = Math.max(0.1, cueEnd - cueStart);
    const s0 = cueStart + Math.min(0.2, dur * 0.08);
    const s1 = cueEnd - Math.min(0.35, dur * 0.12);
    let before = 0;
    let inside = 0;
    let total = 0;
    chars.forEach((ch, i) => {
      const w = speechWeight(ch);
      total += w;
      if (i < from) before += w;
      else if (i < to) inside += w;
    });
    if (!total) return { start: s0, end: s1 };
    const per = (s1 - s0) / total;
    return { start: s0 + before * per, end: s0 + (before + inside) * per };
  }

  // ---- flashcard scheduling (Leitner boxes) -------------------------------

  const DAY = 24 * 3600 * 1000;
  const BOX_DAYS = [0, 1, 3, 7, 16, 35, 90];

  // grade: 'again' | 'good' | 'easy'. Returns the new {box, due}.
  function schedule(card, grade, now = Date.now()) {
    const box = card.box || 0;
    if (grade === 'again') return { box: 0, due: now + 10 * 60 * 1000 };
    const step = grade === 'easy' ? 2 : 1;
    const next = Math.min(BOX_DAYS.length - 1, box + step);
    return { box: next, due: now + BOX_DAYS[next] * DAY };
  }

  const isDue = (card, now = Date.now()) => (card.due || 0) <= now;


  // ---- word gloss (the row under each word) ------------------------------

  const GLOSS_MAX = 18;
  const GLOSS_SKIP = /^(CL:|see |see also |variant of |old variant of |archaic variant of |surname |used in |abbr\. for |also written |also pr\.)/;

  // One short everyday sense from CC-CEDICT defs: the first sense that is
  // not a classifier or a cross-reference, parentheticals removed, cut at a
  // word boundary with an ellipsis when it runs past GLOSS_MAX.
  function shortGloss(defs) {
    for (const raw of defs || []) {
      if (GLOSS_SKIP.test(raw)) continue;
      const d = raw.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
      if (!d) continue;
      if (d.length <= GLOSS_MAX) return d;
      const cut = d.slice(0, GLOSS_MAX).replace(/\s+\S*$/, '').replace(/[,;:\s]+$/, '');
      return (cut || d.slice(0, GLOSS_MAX)) + '\u2026';
    }
    return '';
  }

  // ---- misc ---------------------------------------------------------------

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  // Link that opens the item in Jellyfin and plays [start, end].
  function clipUrl(source, lead = 0.4) {
    const start = Math.max(0, source.start - lead).toFixed(2);
    const end = source.end.toFixed(2);
    return `${source.server}/web/#/details?id=${encodeURIComponent(source.itemId)}` +
      `&zimuStart=${start}&zimuEnd=${end}`;
  }

  function parseClipHash(hash) {
    const q = String(hash || '').split('?')[1];
    if (!q) return null;
    const p = new URLSearchParams(q);
    const id = p.get('id');
    const start = parseFloat(p.get('zimuStart'));
    const end = parseFloat(p.get('zimuEnd'));
    if (!id || !Number.isFinite(start)) return null;
    return { itemId: id, start, end: Number.isFinite(end) ? end : null };
  }

  Object.assign(Z, {
    hasHan,
    syllableToMarked,
    numberedToMarked,
    toneOf,
    cleanCueText,
    splitBilingual,
    cuesFromJellyfin,
    lastStartedIndex,
    activeIndex,
    overlappingText,
    segment,
    estimateSpan,
    schedule,
    isDue,
    shortGloss,
    BOX_DAYS,
    formatTime,
    clipUrl,
    parseClipHash,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = Z;
})(typeof globalThis !== 'undefined' ? globalThis : this);

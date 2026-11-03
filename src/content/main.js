// Zimu overlay for the Jellyfin web player: interactive Chinese subtitles
// with pinyin and English, click-to-define, phrase lookup and flashcards.
(function () {
  'use strict';
  if (window.__zimu) return;
  window.__zimu = true;

  const Z = globalThis.Zimu;
  const J = Z.Jellyfin;
  const PY = globalThis.pinyinPro;

  const S = {
    settings: { ...Z.DEFAULT_SETTINGS },
    dict: null,
    dictLoading: null,
    video: null,
    itemId: null,
    item: null,
    title: '',
    mediaSourceId: null,
    subs: [], // subtitle streams of the current item
    zhTrack: null, // stream index
    enMode: 'none', // stream index (number) | 'embedded' | 'mt' | 'none'
    zh: [], // cues; each may carry .en from a bilingual track
    en: [],
    shown: -2, // index of the cue on screen (-1 none)
    tokens: [], // flat token list of the shown cue
    sel: null, // {a, b} token range while dragging
    autoPausedIdx: -1,
    clipEnd: null,
    pendingClip: null,
    holds: new Set(),
    weePaused: false,
    saved: new Set(),
    mt: new Map(), // zh text -> english | Promise
    status: '',
    statusTimer: 0,
    syncing: false,
    lastSync: 0,
  };

  // ---- tiny DOM helper ----------------------------------------------------

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.style.cssText = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e) }));

  // ---- dictionary / pinyin ------------------------------------------------

  function loadDict() {
    if (!S.dictLoading) {
      S.dictLoading = fetch(chrome.runtime.getURL('data/cedict.u8'))
        .then((r) => r.text())
        .then((t) => { S.dict = new Z.Dict(t); S.lineCache.clear(); render(true); })
        .catch((e) => { console.error('[zimu] dictionary failed', e); setStatus('Dictionary failed to load'); });
    }
    return S.dictLoading;
  }

  // Per-character pinyin for a line, aligned with Array.from(text).
  function charPinyin(text) {
    const chars = Array.from(text);
    if (!PY) return chars.map(() => '');
    const all = PY.pinyin(text, { type: 'all' });
    if (all.length === chars.length) return all.map((x) => (x.isZh ? x.pinyin : ''));
    return chars.map((c) => (Z.hasHan(c) ? PY.pinyin(c) : ''));
  }

  S.lineCache = new Map();

  // A subtitle line -> tokens {text, han, chars:[], py:[]}.
  function tokenize(line) {
    const key = line;
    if (S.lineCache.has(key)) return S.lineCache.get(key);
    const has = S.dict ? (w) => S.dict.has(w) : () => false;
    const toks = Z.segment(line, has, S.dict ? S.dict.maxLen : 1);
    const py = charPinyin(line);
    let k = 0;
    for (const t of toks) {
      t.chars = Array.from(t.text);
      t.py = t.chars.map(() => py[k++] || '');
      // erhua: 哪儿 is nǎr, not nǎér, when the dictionary reads it that way
      const n = t.chars.length;
      if (n > 1 && t.chars[n - 1] === '儿' && S.dict &&
          S.dict.lookup(t.text).some((e) => /\br5$/.test(e.reading))) t.py[n - 1] = 'r';
    }
    if (S.lineCache.size > 500) S.lineCache.clear();
    S.lineCache.set(key, toks);
    return toks;
  }

  const tokenPinyin = (t) => t.py.join('');

  // ---- machine translation ------------------------------------------------

  function mt(text) {
    if (S.mt.has(text)) return S.mt.get(text);
    const p = send({ type: 'translate', text }).then((r) => {
      const out = r && r.ok ? r.text : '';
      S.mt.set(text, out);
      if (!out) S.mt.delete(text);
      return out;
    });
    S.mt.set(text, p);
    return p;
  }

  // English for cue i according to the chosen mode; may return a Promise.
  function englishFor(i) {
    const cue = S.zh[i];
    if (!cue) return '';
    if (S.enMode === 'embedded') return cue.en || '';
    if (typeof S.enMode === 'number') return Z.overlappingText(S.en, cue.start, cue.end);
    if (S.enMode === 'mt') return mt(cue.zhText.replace(/\n/g, ' '));
    return '';
  }

  // ---- overlay DOM ---------------------------------------------------------

  const root = h('div', { id: 'zimu-root', class: 'zimu-hidden' });
  const toolbar = h('div', { class: 'zimu-toolbar' });
  const lines = h('div', { class: 'zimu-lines' });
  const zhBox = h('div', { class: 'zimu-zh' });
  const enBox = h('div', { class: 'zimu-en' });
  const statusEl = h('span', { class: 'zimu-status' });
  let popup = null;
  let panel = null;

  lines.append(zhBox, enBox);
  root.append(toolbar, lines);

  function button(label, title, onclick) {
    return h('button', { class: 'zimu-btn', title, onclick: (e) => { e.stopPropagation(); onclick(e); } }, label);
  }

  const autoBtn = button('⏸ auto', 'Pause at the end of each line (Q)', () => toggleAutoPause());
  toolbar.append(
    button('⏮', 'Previous line (A)', () => gotoLine('prev')),
    button('↻', 'Repeat line (S)', () => gotoLine('repeat')),
    button('⏭', 'Next line (D)', () => gotoLine('next')),
    autoBtn,
    button('⚙', 'Subtitle settings', () => togglePanel()),
    button('🗂', 'Flashcards', () => send({ type: 'openCards' })),
    statusEl,
  );

  function setStatus(text, ms = 6000) {
    S.status = text;
    statusEl.textContent = text;
    clearTimeout(S.statusTimer);
    if (ms) S.statusTimer = setTimeout(() => { statusEl.textContent = ''; }, ms);
  }

  function applySettings() {
    const st = S.settings;
    root.style.setProperty('--zimu-size', `${st.fontSize}px`);
    root.style.setProperty('--zimu-bottom', `${st.bottom}vh`);
    root.classList.toggle('zimu-tones', !!st.toneColors);
    document.documentElement.classList.toggle('zimu-hide-native', !!st.hideNativeSubs && !!S.video && S.zhTrack != null);
    autoBtn.classList.toggle('zimu-on', !!st.autoPause);
    render(true);
  }

  // ---- rendering -----------------------------------------------------------

  function renderZh(cue) {
    zhBox.textContent = '';
    S.tokens = [];
    if (!cue) return;
    const st = S.settings;
    const showH = st.showHanzi;
    const showP = st.showPinyin;
    if (!showH && !showP) return;
    for (const line of cue.zhText.split('\n')) {
      const row = h('div', { class: 'zimu-row' });
      const lineToks = tokenize(line);
      for (let k = 0; k < lineToks.length; k++) {
        const t = lineToks[k];
        if (!t.han) {
          row.append(h('span', { class: 'zimu-p' }, showH ? t.text : t.text.replace(/[，。！？、；：]/g, (c) => ({ '，': ', ', '。': '. ', '！': '! ', '？': '? ', '、': ', ', '；': '; ', '：': ': ' })[c])));
          continue;
        }
        const ti = S.tokens.length;
        S.tokens.push({ ...t, lineToks, k });
        const w = h('span', { class: 'zimu-w' + (S.saved.has(t.text) ? ' zimu-saved' : ''), 'data-t': ti });
        if (showH) {
          t.chars.forEach((c, k) => {
            const tone = st.toneColors ? ` zimu-t${Z.toneOf(t.py[k])}` : '';
            if (showP) w.append(h('ruby', { class: tone.trim() }, c, h('rt', null, t.py[k])));
            else w.append(h('span', { class: tone.trim() }, c));
          });
        } else {
          w.classList.add('zimu-py-only');
          t.py.forEach((p, k) => {
            const tone = st.toneColors ? `zimu-t${Z.toneOf(p)}` : '';
            w.append(h('span', { class: tone }, p || t.chars[k]));
          });
        }
        row.append(w);
      }
      zhBox.append(row);
    }
  }

  function renderEn(i) {
    enBox.textContent = '';
    if (!S.settings.showEnglish || i < 0) return;
    const en = englishFor(i);
    if (en && typeof en.then === 'function') {
      enBox.textContent = '…';
      en.then((text) => { if (S.shown === i) enBox.textContent = text; });
    } else {
      enBox.textContent = en;
    }
    // prefetch machine translations for the next lines
    if (S.enMode === 'mt') for (let k = 1; k <= 2; k++) if (S.zh[i + k]) englishFor(i + k);
  }

  function render(force) {
    const v = S.video;
    root.dataset.state = `item=${S.itemId || '-'} zh=${S.zh.length} shown=${S.shown} dict=${S.dict ? 'y' : 'n'}`;
    if (!v || !S.zh.length) {
      if (S.shown !== -1 || force) { zhBox.textContent = ''; enBox.textContent = ''; S.shown = -1; }
      return;
    }
    const t = v.currentTime;
    const active = Z.activeIndex(S.zh, t);
    // Keep the last line up (dimmed) until the next one starts.
    const idx = active >= 0 ? active : Z.lastStartedIndex(S.zh, t);
    lines.classList.toggle('zimu-past', active < 0);
    if (idx === S.shown && !force) return;
    S.shown = idx;
    const cue = S.zh[idx];
    renderZh(cue);
    renderEn(idx);
  }

  // ---- playback loop -------------------------------------------------------

  let raf = 0;
  function tick() {
    raf = 0;
    const v = S.video;
    if (!v) return;
    const t = v.currentTime;
    if (S.clipEnd != null && !v.paused && t >= S.clipEnd) {
      S.clipEnd = null;
      v.pause();
    }
    if (S.settings.autoPause && !v.paused && S.zh.length) {
      const i = Z.activeIndex(S.zh, t);
      const cue = S.zh[i];
      if (cue && t >= cue.end - 0.08 && S.autoPausedIdx !== i) {
        S.autoPausedIdx = i;
        v.pause();
      }
    }
    render(false);
    if (!v.paused) raf = requestAnimationFrame(tick);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

  function seek(sec, play = true) {
    const v = S.video;
    if (!v) return;
    S.ourSeek = true;
    v.currentTime = Math.max(0, sec);
    if (play && v.paused) v.play().catch(() => {});
    kick();
  }

  function gotoLine(which) {
    const v = S.video;
    if (!v || !S.zh.length) return;
    const t = v.currentTime;
    const active = Z.activeIndex(S.zh, t);
    const last = Z.lastStartedIndex(S.zh, t);
    let target;
    if (which === 'prev') target = active >= 0 ? active - 1 : last;
    else if (which === 'repeat') target = active >= 0 ? active : last;
    else target = last + 1;
    const cue = S.zh[Math.max(0, Math.min(S.zh.length - 1, target))];
    if (!cue) return;
    S.autoPausedIdx = -1;
    S.clipEnd = null;
    seek(cue.start - 0.15);
  }

  function toggleAutoPause() {
    Z.Settings.set({ autoPause: !S.settings.autoPause });
    setStatus(!S.settings.autoPause ? 'Auto-pause on' : 'Auto-pause off', 2000);
  }

  // Pausing on behalf of a hover or an open popup; resume only if we paused.
  function hold(reason) {
    S.holds.add(reason);
    const v = S.video;
    if (v && !v.paused) { S.weePaused = true; v.pause(); }
  }
  function release(reason) {
    S.holds.delete(reason);
    if (!S.holds.size && S.weePaused) {
      S.weePaused = false;
      if (S.video) S.video.play().catch(() => {});
    }
  }

  // ---- popups --------------------------------------------------------------

  function closePopup() {
    if (popup) { popup.remove(); popup = null; }
    clearSelection();
    release('popup');
  }

  function clearSelection() {
    S.sel = null;
    zhBox.querySelectorAll('.zimu-sel').forEach((e) => e.classList.remove('zimu-sel'));
  }

  function openPopup(content, anchorRect) {
    if (popup) popup.remove();
    hold('popup');
    popup = h('div', { class: 'zimu-popup', onmousedown: (e) => e.stopPropagation() },
      h('button', { class: 'zimu-x', title: 'Close (Esc)', onclick: () => closePopup() }, '×'),
      content);
    root.append(popup);
    const pr = popup.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    let left = anchorRect.left + anchorRect.width / 2 - pr.width / 2;
    left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, left));
    let top = anchorRect.top - pr.height - 10;
    if (top < 8) top = 8;
    popup.style.left = `${left - rr.left}px`;
    popup.style.top = `${top - rr.top}px`;
  }

  function speak(text) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 0.85;
      speechSynthesis.speak(u);
    } catch { /* no speech engine */ }
  }

  function cueSource(i) {
    const cue = S.zh[i];
    if (!cue || !S.itemId) return null;
    return {
      server: J.serverBase(),
      itemId: S.itemId,
      mediaSourceId: S.mediaSourceId,
      title: S.title,
      start: cue.start,
      end: cue.end,
    };
  }

  async function sentenceFor(i) {
    const cue = S.zh[i];
    if (!cue) return null;
    const pyLine = cue.zhText.split('\n').map((l) => tokenize(l).map((t) => (t.han ? tokenPinyin(t) : t.text.trim())).filter(Boolean).join(' ')).join(' / ');
    let en = englishFor(i);
    if (en && typeof en.then === 'function') en = await Promise.race([en, new Promise((r) => setTimeout(() => r(''), 4000))]);
    if (!en && S.enMode !== 'mt') en = await Promise.race([mt(cue.zhText.replace(/\n/g, ' ')), new Promise((r) => setTimeout(() => r(''), 4000))]);
    return { zh: cue.zhText, pinyin: pyLine, en: en || '' };
  }

  function saveButton(hanzi, makeCard) {
    const b = h('button', { class: 'zimu-save' });
    const paint = () => { b.textContent = S.saved.has(hanzi) ? '★ Saved' : '☆ Save to flashcards'; };
    paint();
    b.addEventListener('click', async () => {
      if (S.saved.has(hanzi)) {
        await Z.Cards.removeByHanzi(hanzi);
        S.saved.delete(hanzi);
      } else {
        b.textContent = 'Saving…';
        await Z.Cards.add(await makeCard());
        S.saved.add(hanzi);
      }
      paint();
        renderZh(S.zh[S.shown]);
    });
    return b;
  }

  function defsBlock(word, maxEntries = 4) {
    const entries = S.dict ? S.dict.lookup(word) : [];
    if (!entries.length) return h('div', { class: 'zimu-muted' }, S.dict ? 'No dictionary entry.' : 'Dictionary loading…');
    return h('div', { class: 'zimu-entries' }, entries.slice(0, maxEntries).map((e) =>
      h('div', { class: 'zimu-entry' },
        h('span', { class: 'zimu-entry-py' }, e.pinyin),
        e.trad !== e.simp ? h('span', { class: 'zimu-muted' }, ` ${e.simp === word ? e.trad : e.simp}`) : null,
        h('ol', null, e.defs.slice(0, 6).map((d) => h('li', null, d))))));
  }

  function wordPopup(tok, anchorRect) {
    const word = tok.text;
    const ctxPinyin = tokenPinyin(tok);
    const entries = S.dict ? S.dict.lookup(word) : [];
    const chars = tok.chars.length > 1 ? h('div', { class: 'zimu-chars' }, tok.chars.map((c, k) => {
      const ce = S.dict ? S.dict.lookup(c)[0] : null;
      return h('div', { class: 'zimu-char', title: 'Look up', onclick: () => wordPopup({ text: c, chars: [c], py: [tok.py[k]] }, anchorRect) },
        h('span', { class: 'zimu-char-h' }, c), h('span', { class: 'zimu-char-py' }, tok.py[k]),
        h('span', { class: 'zimu-muted' }, ce ? ce.defs.slice(0, 2).join('; ') : ''));
    })) : null;
    const shownIdx = S.shown;
    const card = async () => ({
      kind: 'word',
      hanzi: word,
      trad: entries[0] && entries[0].trad !== word ? entries[0].trad : '',
      pinyin: ctxPinyin,
      english: entries.length ? entries[0].defs.slice(0, 4).join('; ') : (await mt(word)),
      sentence: await sentenceFor(shownIdx),
      source: cueSource(shownIdx),
    });
    openPopup(h('div', null,
      h('div', { class: 'zimu-head' },
        h('span', { class: 'zimu-big' }, word),
        h('span', { class: 'zimu-head-py' }, ctxPinyin),
        h('button', { class: 'zimu-btn', title: 'Say it', onclick: () => speak(word) }, '🔊')),
      defsBlock(word),
      chars,
      h('div', { class: 'zimu-actions' },
        saveButton(word, card),
        h('button', { class: 'zimu-btn', onclick: () => gotoLine('repeat') }, '↻ Replay line'))),
    anchorRect);
  }

  function phrasePopup(toks, anchorRect) {
    const text = toks.map((t) => t.text).join('');
    const py = toks.filter((t) => t.han).map(tokenPinyin).join(' ');
    const tr = h('div', { class: 'zimu-translation' }, 'Translating…');
    const translation = mt(text);
    Promise.resolve(translation).then((out) => { tr.textContent = out || '(translation unavailable)'; });
    const shownIdx = S.shown;
    const card = async () => ({
      kind: 'phrase',
      hanzi: text,
      pinyin: py,
      english: (await translation) || '',
      sentence: await sentenceFor(shownIdx),
      source: cueSource(shownIdx),
    });
    openPopup(h('div', null,
      h('div', { class: 'zimu-head' },
        h('span', { class: 'zimu-big' }, text),
        h('button', { class: 'zimu-btn', title: 'Say it', onclick: () => speak(text) }, '🔊')),
      h('div', { class: 'zimu-head-py' }, py),
      tr,
      h('div', { class: 'zimu-breakdown' }, toks.filter((t) => t.han).map((t) => {
        const e = S.dict ? S.dict.lookup(t.text)[0] : null;
        return h('div', { class: 'zimu-bd-row', onclick: () => wordPopup(t, anchorRect) },
          h('span', { class: 'zimu-bd-h' }, t.text),
          h('span', { class: 'zimu-bd-py' }, tokenPinyin(t)),
          h('span', { class: 'zimu-muted' }, e ? e.defs.slice(0, 2).join('; ') : ''));
      })),
      h('div', { class: 'zimu-actions' },
        saveButton(text, card),
        h('button', { class: 'zimu-btn', onclick: () => gotoLine('repeat') }, '↻ Replay line'))),
    anchorRect);
  }

  // ---- word clicks and drag-to-select --------------------------------------

  const tokenIndex = (el) => {
    const w = el && el.closest && el.closest('.zimu-w');
    return w ? Number(w.dataset.t) : -1;
  };

  function paintSelection() {
    const { a, b } = S.sel;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    zhBox.querySelectorAll('.zimu-w').forEach((el) => {
      const t = Number(el.dataset.t);
      el.classList.toggle('zimu-sel', t >= lo && t <= hi);
    });
  }

  zhBox.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const t = tokenIndex(e.target);
    if (t < 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey && S.sel) S.sel.b = t; else S.sel = { a: t, b: t };
    S.dragging = true;
    paintSelection();
  });
  zhBox.addEventListener('mouseover', (e) => {
    if (!S.dragging) return;
    const t = tokenIndex(e.target);
    if (t >= 0 && S.sel) { S.sel.b = t; paintSelection(); }
  });
  window.addEventListener('mouseup', (e) => {
    if (!S.dragging) return;
    S.dragging = false;
    const { a, b } = S.sel;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const els = [...zhBox.querySelectorAll('.zimu-sel')];
    const rect = els.length ? unionRect(els) : e.target.getBoundingClientRect();
    if (lo === hi) wordPopup(S.tokens[lo], rect);
    else phrasePopup(phraseTokens(lo, hi), rect);
  }, true);
  // Swallow clicks on the overlay so Jellyfin doesn't toggle play/pause.
  root.addEventListener('click', (e) => e.stopPropagation());
  root.addEventListener('dblclick', (e) => e.stopPropagation());

  // Selected tokens lo..hi, plus the punctuation between them on each line.
  function phraseTokens(lo, hi) {
    const picked = S.tokens.slice(lo, hi + 1);
    const out = [];
    for (let i = 0; i < picked.length;) {
      const lt = picked[i].lineToks;
      let j = i;
      while (j + 1 < picked.length && picked[j + 1].lineToks === lt) j++;
      out.push(...lt.slice(picked[i].k, picked[j].k + 1));
      i = j + 1;
    }
    return out;
  }

  function unionRect(els) {
    const rs = els.map((el) => el.getBoundingClientRect());
    const left = Math.min(...rs.map((r) => r.left));
    const right = Math.max(...rs.map((r) => r.right));
    const top = Math.min(...rs.map((r) => r.top));
    const bottom = Math.max(...rs.map((r) => r.bottom));
    return { left, top, width: right - left, height: bottom - top };
  }

  lines.addEventListener('mouseenter', () => { if (S.settings.pauseOnHover) hold('hover'); });
  lines.addEventListener('mouseleave', () => release('hover'));

  document.addEventListener('mousedown', (e) => {
    if (popup && !popup.contains(e.target)) closePopup();
    if (panel && !panel.contains(e.target) && !toolbar.contains(e.target)) togglePanel(false);
  }, true);

  // ---- settings panel ------------------------------------------------------

  function togglePanel(force) {
    const open = force ?? !panel;
    if (panel) { panel.remove(); panel = null; }
    if (!open) return;
    const st = S.settings;
    const check = (key, label) => h('label', { class: 'zimu-check' },
      h('input', { type: 'checkbox', checked: !!st[key], onchange: (e) => Z.Settings.set({ [key]: e.target.checked }) }), label);
    const zhOpts = S.subs.filter((s) => s.text);
    const zhSel = h('select', { onchange: (e) => chooseTracks(Number(e.target.value), 'auto') },
      zhOpts.length ? null : h('option', null, 'No text subtitles'),
      zhOpts.map((s) => h('option', { value: s.index, selected: s.index === S.zhTrack }, s.title)));
    const enSel = h('select', { onchange: (e) => {
      const v = e.target.value;
      chooseTracks(S.zhTrack, /^\d+$/.test(v) ? Number(v) : v);
    } },
    h('option', { value: 'embedded', selected: S.enMode === 'embedded' }, 'From the Chinese track (bilingual)'),
    h('option', { value: 'mt', selected: S.enMode === 'mt' }, 'Machine translation'),
    h('option', { value: 'none', selected: S.enMode === 'none' }, 'None'),
    zhOpts.map((s) => h('option', { value: s.index, selected: s.index === S.enMode }, s.title)));
    const range = (key, label, min, max) => h('label', { class: 'zimu-range' }, label,
      h('input', { type: 'range', min, max, value: st[key], oninput: (e) => Z.Settings.set({ [key]: Number(e.target.value) }) }));
    panel = h('div', { class: 'zimu-panel', onmousedown: (e) => e.stopPropagation() },
      h('div', { class: 'zimu-panel-title' }, 'Show'),
      h('div', { class: 'zimu-row-flex' }, check('showHanzi', 'Hanzi'), check('showPinyin', 'Pinyin'), check('showEnglish', 'English')),
      h('div', { class: 'zimu-panel-title' }, 'Tracks'),
      h('label', { class: 'zimu-field' }, 'Chinese', zhSel),
      h('label', { class: 'zimu-field' }, 'English', enSel),
      h('div', { class: 'zimu-panel-title' }, 'Behaviour'),
      check('pauseOnHover', 'Pause while the mouse is over the subtitles'),
      check('autoPause', 'Pause at the end of each line (Q)'),
      check('hideNativeSubs', 'Hide Jellyfin’s own subtitles'),
      check('toneColors', 'Colour by tone'),
      check('machineTranslate', 'Machine-translate when there is no English track'),
      range('fontSize', 'Size', 18, 64),
      range('bottom', 'Height', 2, 60),
      h('div', { class: 'zimu-muted' }, 'Keys: A previous · S repeat · D next · Q auto-pause · Esc close'));
    root.append(panel);
  }

  // ---- item / track loading ------------------------------------------------

  async function syncNowPlaying(reason) {
    if (S.syncing) return;
    S.syncing = true;
    S.lastSync = Date.now();
    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        let session = null;
        try { session = await J.mySession(S.video ? S.video.currentTime : null); } catch (e) { console.warn('[zimu]', e); }
        const np = session && session.NowPlayingItem;
        if (np && np.Id) {
          if (np.Id !== S.itemId) await loadItem(np.Id, session.PlayState && session.PlayState.MediaSourceId);
          return;
        }
        if (!S.video) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (reason === 'start') setStatus('Couldn’t find what Jellyfin is playing');
    } finally {
      S.syncing = false;
    }
  }

  async function loadItem(itemId, mediaSourceId) {
    S.itemId = itemId;
    S.zh = [];
    S.en = [];
    S.zhTrack = null;
    S.shown = -2;
    S.autoPausedIdx = -1;
    render(true);
    try {
      S.item = await J.item(itemId);
    } catch (e) {
      setStatus(String(e.message || e));
      return;
    }
    S.title = J.itemTitle(S.item);
    const { mediaSourceId: msId, subs } = J.subtitleStreams(S.item, mediaSourceId);
    S.mediaSourceId = msId;
    S.subs = subs;
    const { zh, en } = J.pickTracks(subs.slice());
    if (!zh) {
      setStatus(subs.length ? 'No Chinese subtitle track on this video (⚙ to pick one)' : 'This video has no subtitles', 10000);
      applySettings();
      return;
    }
    if (!zh.text) {
      setStatus('The Chinese subtitles are images (PGS/VobSub); Zimu needs text (SRT/ASS)', 12000);
      applySettings();
      return;
    }
    await chooseTracks(zh.index, en ? en.index : 'auto');
  }

  async function chooseTracks(zhIndex, enMode) {
    if (!S.itemId) return;
    const itemId = S.itemId;
    try {
      setStatus('Loading subtitles…', 0);
      const zh = await J.subtitleCues(itemId, S.mediaSourceId, zhIndex);
      if (itemId !== S.itemId) return;
      for (const cue of zh) {
        const { zh: z, en } = Z.splitBilingual(cue.text);
        cue.zhText = z;
        cue.en = en;
      }
      S.zh = zh.filter((c) => c.zhText);
      S.zhTrack = zhIndex;
      const embedded = S.zh.filter((c) => c.en).length > S.zh.length * 0.3;
      if (enMode === 'auto') {
        const enTrack = J.pickTracks(S.subs.slice()).en;
        enMode = embedded ? 'embedded' : enTrack ? enTrack.index : S.settings.machineTranslate ? 'mt' : 'none';
      }
      S.en = typeof enMode === 'number' ? await J.subtitleCues(itemId, S.mediaSourceId, enMode) : [];
      S.enMode = enMode;
      setStatus(S.zh.length ? `${S.zh.length} lines · ${S.title}` : 'That track has no Chinese text', 4000);
      loadDict();
      applySettings();
      if (S.pendingClip && S.pendingClip.itemId === itemId) startPendingClip();
    } catch (e) {
      console.error('[zimu]', e);
      setStatus(`Subtitles failed: ${e.message || e}`);
    }
  }

  // ---- clips (flashcard "play this moment") --------------------------------

  function startPendingClip() {
    const c = S.pendingClip;
    const v = S.video;
    if (!c || !v || c.itemId !== S.itemId) return;
    S.pendingClip = null;
    if (Math.abs(v.currentTime - c.start) > 1.5) seek(c.start);
    else if (v.paused) v.play().catch(() => {});
    S.clipEnd = c.end;
    kick();
  }

  async function playClip(src) {
    const start = Math.max(0, src.start - (src.lead ?? 0));
    const clip = { itemId: src.itemId, start, end: src.end ?? null };
    if (S.video && S.itemId === src.itemId) {
      S.clipEnd = clip.end;
      seek(start);
      return true;
    }
    S.pendingClip = clip;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await J.playOnThisClient(src.itemId, start, src.mediaSourceId);
        return true;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    setStatus('Couldn’t start playback for that card');
    return false;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'playClip') {
      if (!J.credentials()) { sendResponse({ ok: false }); return false; }
      playClip({ ...msg.source, lead: 0.4 }).then((ok) => sendResponse({ ok }));
      return true;
    }
    return false;
  });

  function checkHashClip() {
    const c = Z.parseClipHash(location.hash);
    if (!c) return;
    // drop our parameters so a reload doesn't replay the clip
    const clean = location.hash.replace(/&zimu(Start|End)=[^&]*/g, '');
    history.replaceState(history.state, '', location.pathname + location.search + clean);
    playClip(c);
  }

  // ---- video discovery -----------------------------------------------------

  const videoEvents = {
    play: () => {
      // someone pressed play while we were holding: stop holding
      if (S.holds.size) { S.holds.clear(); S.weePaused = false; }
      kick();
    },
    playing: () => {
      if (!S.itemId || Date.now() - S.lastSync > 3000) syncNowPlaying('start');
      if (S.pendingClip && S.pendingClip.itemId === S.itemId && S.zh.length) startPendingClip();
      kick();
    },
    loadstart: () => { S.itemId = null; S.zh = []; S.shown = -2; render(true); },
    seeking: () => {
      if (!S.ourSeek) { S.clipEnd = null; }
      S.ourSeek = false;
      S.autoPausedIdx = -1;
      kick();
    },
    seeked: () => kick(),
    pause: () => kick(),
  };

  function attach(video) {
    if (S.video === video) return;
    detach();
    S.video = video;
    for (const [ev, fn] of Object.entries(videoEvents)) video.addEventListener(ev, fn);
    document.body.append(root);
    root.classList.remove('zimu-hidden');
    loadDict();
    syncNowPlaying('start');
    applySettings();
    kick(); // the video may already be playing, so no 'play' event will come
  }

  function detach() {
    if (!S.video) return;
    for (const [ev, fn] of Object.entries(videoEvents)) S.video.removeEventListener(ev, fn);
    S.video = null;
    S.itemId = null;
    S.zh = [];
    S.zhTrack = null;
    S.holds.clear();
    closePopup();
    togglePanel(false);
    root.classList.add('zimu-hidden');
    document.documentElement.classList.remove('zimu-hide-native');
  }

  function findVideo() {
    const v = document.querySelector('video.htmlvideoplayer') ||
      [...document.querySelectorAll('video')].find((x) => x.getBoundingClientRect().width > 200);
    return v && v.isConnected ? v : null;
  }

  setInterval(() => {
    const v = findVideo();
    if (v && J.credentials()) attach(v); else if (!v) detach();
    if (S.video) {
      // lift the subtitles above Jellyfin's control bar while it shows
      const osd = document.querySelector('.videoOsdBottom');
      const visible = osd && !osd.classList.contains('videoOsdBottom-hidden') && osd.getBoundingClientRect().height > 0 &&
        getComputedStyle(osd).opacity !== '0';
      root.style.setProperty('--zimu-lift', visible ? `${Math.round(osd.getBoundingClientRect().height)}px` : '0px');
      if (!S.video.paused) kick(); // keeps the loop alive if a frame was missed
      if (!S.video.paused && Date.now() - S.lastSync > 15000) syncNowPlaying('poll');
    }
  }, 500);

  // ---- keyboard -------------------------------------------------------------

  document.addEventListener('keydown', (e) => {
    if (!S.video || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
    const k = e.key.toLowerCase();
    const act = { a: () => gotoLine('prev'), s: () => gotoLine('repeat'), d: () => gotoLine('next'), q: toggleAutoPause }[k];
    if (e.key === 'Escape' && (popup || panel)) { closePopup(); togglePanel(false); }
    else if (act) act();
    else return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);

  // ---- startup ---------------------------------------------------------------

  Z.Settings.get().then((s) => { S.settings = s; applySettings(); });
  Z.Cards.all().then((cards) => { S.saved = new Set(cards.map((c) => c.hanzi)); });
  Z.Cards.onChange((cards) => { S.saved = new Set(cards.map((c) => c.hanzi)); render(true); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      S.settings = { ...Z.DEFAULT_SETTINGS, ...changes.settings.newValue };
      applySettings();
      if (panel) { togglePanel(false); togglePanel(true); }
    }
  });
  window.addEventListener('hashchange', checkHashClip);
  checkHashClip();
})();

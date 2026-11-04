// Zimu overlay for the Jellyfin web player: interactive Chinese subtitles
// with pinyin and English, click-to-define, phrase lookup and flashcards.
(function () {
  'use strict';
  if (window.__zimu) return;
  window.__zimu = true;

  // An update or reload of the extension starts a new copy of this script in
  // tabs that are already open (Firefox/Zen); the old copy's overlay and bar
  // buttons stay in the page, frozen. Clear them so only this copy's show.
  document.querySelectorAll('#zimu-root, .zimu-osd, .zimu-flash').forEach((el) => el.remove());
  document.documentElement.classList.remove('zimu-hide-native');

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
    showKey: null, // series id (or the item's own, for a film): Off is remembered per show
    enMode: 'none', // stream index (number) | 'embedded' | 'mt' | 'none'
    zh: [], // cues; each may carry .en from a bilingual track
    en: [],
    shown: -2, // index of the cue on screen (-1 none)
    anchor: -2, // index of the cue playing or last finished (-1 before the first)
    tokens: [], // flat token list of the shown cue
    sel: null, // {a, b} token range while dragging
    autoPausedIdx: -1,
    clipEnd: null,
    pendingClip: null,
    holds: new Set(),
    weePaused: false,
    saved: new Set(),
    mt: new Map(), // zh text -> english | Promise
    dismissedKeys: new Set(), // explanations closed with × this session
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
        .catch((e) => { console.error('[zimu] dictionary failed', e); setStatus('Dictionary failed to load', 0); });
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
  root.append(lines, toolbar);

  function button(label, title, onclick) {
    return h('button', { class: 'zimu-btn', title, onclick: (e) => { e.stopPropagation(); onclick(e); } }, label);
  }

  const autoBtn = button('Auto-pause', 'Pause at the end of each line (Q)', () => toggleAutoPause());
  const playBtn = button('▶', 'Play / pause (space)', () => {
    const v = S.video;
    if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  });
  playBtn.classList.add('zimu-play');
  const paintPlay = () => {
    const playing = !!S.video && !S.video.paused;
    playBtn.textContent = playing ? '⏸' : '▶';
  };
  toolbar.append(
    button('⏮', 'Previous line (A)', () => gotoLine('prev')),
    playBtn,
    button('⏭', 'Next line (D)', () => gotoLine('next')),
    autoBtn,
    statusEl,
  );

  // ---- controls in Jellyfin's own bottom bar ---------------------------------
  // Speed (type a % or step it), settings and flashcards sit among Jellyfin's
  // buttons, before its own ⚙. Jellyfin re-creates that bar with the player,
  // so mountOsd() re-inserts the group whenever it's missing.

  function osdButton(icon, fallback, title, onclick) {
    const b = h('button', {
      type: 'button',
      is: 'paper-icon-button-light',
      class: 'paper-icon-button-light autoSize zimu-osd-btn',
      title,
      'aria-label': title,
      onclick: (e) => { e.stopPropagation(); onclick(e, b); },
    }, h('span', { class: `largePaperIconButton material-icons ${icon}`, 'aria-hidden': 'true', 'data-fallback': fallback }));
    return b;
  }

  const speedInput = h('input', {
    class: 'zimu-speed-input',
    type: 'text',
    inputmode: 'numeric',
    maxlength: '3',
    value: '100',
    title: 'Playback speed, 60–100% (type a number, ↑/↓ to step)',
    'aria-label': 'Playback speed percent',
  });
  const speedBox = h('label', { class: 'zimu-speed-box' }, speedInput, '%');
  const commitSpeed = () => {
    const n = parseInt(speedInput.value, 10);
    if (Number.isFinite(n)) setSpeed(n); else paintSpeed(S.settings.speed);
  };
  speedInput.addEventListener('focus', () => speedInput.select());
  speedInput.addEventListener('input', () => { speedInput.value = speedInput.value.replace(/\D/g, '').slice(0, 3); });
  speedInput.addEventListener('blur', commitSpeed);
  speedInput.addEventListener('keydown', (e) => {
    e.stopPropagation(); // Jellyfin's player treats digits as "seek to N0%"
    if (e.key === 'Enter') { e.preventDefault(); speedInput.blur(); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      speedInput.value = String(clampSpeed(S.settings.speed)); // so the blur commit is a no-op
      speedInput.blur();
    }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const step = (e.shiftKey ? 5 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      setSpeed((parseInt(speedInput.value, 10) || S.settings.speed) + step);
      speedInput.select();
    }
  });

  // Press-and-hold: one step at once, then after HOLD_DELAY it repeats,
  // starting every HOLD_START ms and speeding up by HOLD_ACCEL per step down
  // to HOLD_FASTEST (60→100% takes ~2 s of holding).
  const HOLD_DELAY = 400;
  const HOLD_START = 160;
  const HOLD_ACCEL = 0.85;
  const HOLD_FASTEST = 35;

  function holdToRepeat(btn, step) {
    let timer = 0;
    const stop = () => { clearTimeout(timer); timer = 0; };
    const run = (wait) => {
      timer = setTimeout(() => {
        step();
        run(Math.max(HOLD_FASTEST, wait * HOLD_ACCEL));
      }, wait);
    };
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      btn.setPointerCapture?.(e.pointerId);
      stop();
      step();
      timer = setTimeout(() => run(HOLD_START), HOLD_DELAY - HOLD_START);
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) btn.addEventListener(ev, stop);
    // keyboard activation (Enter/Space on the focused button) arrives as a
    // click with detail 0; mouse clicks were already handled on pointerdown
    btn.addEventListener('click', (e) => { if (e.detail === 0) step(); }, true);
  }

  const settingsBtn = osdButton('tune', 'tune', 'Zimu subtitle settings', (_e, b) => togglePanel(undefined, b));
  const slowerBtn = osdButton('remove', 'remove', 'Slower by 1% — hold to keep going ([)', () => {});
  const fasterBtn = osdButton('add', 'add', 'Faster by 1% — hold to keep going (])', () => {});
  settingsBtn.classList.add('zimu-osd-tune');
  holdToRepeat(slowerBtn, () => setSpeed(S.settings.speed - 1));
  holdToRepeat(fasterBtn, () => setSpeed(S.settings.speed + 1));
  // The on/off switch: Zimu for this show (remembered per series).
  const zimuSwitch = h('button', {
    type: 'button',
    class: 'zimu-osd-toggle',
    role: 'switch',
    onclick: (e) => { e.stopPropagation(); setOff(!isOff()); },
  }, h('span', { class: 'zimu-switch-label' }, 'Zimu'), h('span', { class: 'zimu-switch-track' }, h('span', { class: 'zimu-switch-knob' })));

  function paintSwitch() {
    const can = !!S.showKey && S.zh.length > 0;
    const on = can && !isOff();
    zimuSwitch.disabled = !can;
    zimuSwitch.classList.toggle('zimu-on', on);
    zimuSwitch.setAttribute('aria-checked', String(on));
    const title = !can ? S.status || 'Zimu: no Chinese subtitles on this video'
      : on ? 'Zimu is on — click to turn it off for this show (Z)' : 'Zimu is off for this show — click to turn it on (Z)';
    zimuSwitch.title = title;
    zimuSwitch.setAttribute('aria-label', title);
  }

  const osdGroup = h('div', { class: 'zimu-osd' },
    zimuSwitch,
    slowerBtn,
    speedBox,
    fasterBtn,
    settingsBtn,
    osdButton('style', 'style', 'Zimu flashcards', () => send({ type: 'openCards' })));

  function paintSpeed(speed) {
    const n = clampSpeed(speed);
    if (document.activeElement !== speedInput) speedInput.value = String(n);
    speedBox.classList.toggle('zimu-on', n !== 100);
  }

  // Jellyfin keeps recently visited pages in the document, hidden with
  // .hide, so an older player page's bar can come first. Use the bar of the
  // page on screen (the bar itself also gets .hide while the controls are
  // tucked away, so that one doesn't count).
  function activeOsdBar() {
    const bars = [...document.querySelectorAll('.videoOsdBottom-maincontrols .osdControls .buttons, .osdControls .buttons')];
    const onShownPage = (bar) => {
      for (let el = bar.parentElement; el && el !== document.body; el = el.parentElement) {
        if (el.classList.contains('hide') && !el.classList.contains('videoOsdBottom')) return false;
      }
      return true;
    };
    const shown = bars.filter(onShownPage);
    return shown[shown.length - 1] || null;
  }

  function mountOsd() {
    const bar = activeOsdBar();
    if (!bar || osdGroup.parentElement === bar) return;
    const before = bar.querySelector(':scope > .btnVideoOsdSettings');
    bar.insertBefore(osdGroup, before || null);
    // Jellyfin draws icons from CSS classes; fall back to the font's ligature
    // names if a class has no glyph.
    osdGroup.querySelectorAll('[data-fallback]').forEach((span) => {
      const c = getComputedStyle(span, '::before').content;
      if (!c || c === 'none' || c === 'normal' || c === '""') span.textContent = span.dataset.fallback;
    });
  }

  function setStatus(text, ms = 6000) {
    S.status = text;
    statusEl.textContent = text;
    clearTimeout(S.statusTimer);
    if (ms) S.statusTimer = setTimeout(() => { statusEl.textContent = ''; }, ms);
    paintSwitch(); // with no lines to show, the switch's tooltip says why
  }

  // Off for this show: no overlay, no auto-pause or speed, Jellyfin's own
  // subtitles back. Remembered per series so the next episode stays off.
  const OFF_SHOWS_KEPT = 500;
  const isOff = () => !!S.showKey && (S.settings.offShows || []).includes(S.showKey);
  // Nothing to show (no subtitles, none in Chinese, or still loading): Zimu
  // stays out of the way, as when off, leaving the disabled switch.
  const noLines = () => !S.zh.length;

  function setOff(off) {
    if (!S.showKey || off === isOff()) return;
    const rest = (S.settings.offShows || []).filter((k) => k !== S.showKey);
    const offShows = off ? [...rest, S.showKey].slice(-OFF_SHOWS_KEPT) : rest;
    S.settings.offShows = offShows;
    Z.Settings.set({ offShows });
    if (off) { closePopup(); closeExplain(); }
    applySettings();
    if (panel) { togglePanel(false); togglePanel(true); }
    setStatus(off ? '' : 'Zimu on', 2000);
    if (off) flash('Zimu off for this show · Z turns it back on');
  }

  // A short notice while the overlay itself is hidden.
  let flashEl = null;
  let flashTimer = 0;
  function flash(text) {
    if (!flashEl) flashEl = h('div', { class: 'zimu-flash' });
    flashEl.textContent = text;
    document.body.append(flashEl);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flashEl.remove(), 2500);
  }

  function applySettings() {
    const st = S.settings;
    const off = isOff();
    root.classList.toggle('zimu-off', off || noLines());
    osdGroup.classList.toggle('zimu-off', off || noLines());
    // the track menu stays if there is a text track to pick by hand
    osdGroup.classList.toggle('zimu-bare', noLines() && !S.subs.some((s) => s.text));
    paintSwitch();
    root.style.setProperty('--zimu-size', `${st.fontSize}px`);
    root.style.setProperty('--zimu-bottom', `${st.bottom}vh`);
    root.style.setProperty('--zimu-text-alpha', String(st.textOpacity / 100));
    root.style.setProperty('--zimu-bg-alpha', String(st.bgOpacity / 100));
    root.classList.toggle('zimu-tones', !!st.toneColors);
    document.documentElement.classList.toggle('zimu-hide-native', !!st.hideNativeSubs && !!S.video && S.zhTrack != null && !off);
    autoBtn.classList.toggle('zimu-on', !!st.autoPause);
    paintSpeed(st.speed);
    applySpeed();
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
    let pos = 0; // code-point offset in cue.zhText, for word timing
    cue.zhText.split('\n').forEach((line, li) => {
      if (li) pos += 1; // the line break
      const row = h('div', { class: 'zimu-row' });
      const lineToks = tokenize(line);
      for (let k = 0; k < lineToks.length; k++) {
        const t = lineToks[k];
        const from = pos;
        pos += t.chars.length;
        if (!t.han) {
          row.append(h('span', { class: 'zimu-p' }, showH ? t.text : t.text.replace(/[，。！？、；：]/g, (c) => ({ '，': ', ', '。': '. ', '！': '! ', '？': '? ', '、': ', ', '；': '; ', '：': ': ' })[c])));
          continue;
        }
        const ti = S.tokens.length;
        S.tokens.push({ ...t, lineToks, k, from, to: pos });
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
    });
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
    if (!v || !S.zh.length || isOff()) {
      if (S.shown !== -1 || force) { zhBox.textContent = ''; enBox.textContent = ''; S.shown = -1; }
      return;
    }
    const t = v.currentTime;
    const active = Z.activeIndex(S.zh, t);
    const last = Z.lastStartedIndex(S.zh, t);
    // A finished line stays up (dimmed) for LINGER_SECONDS so it can be
    // finished reading, then clears through the rest of a silence.
    const lingering = active < 0 && last >= 0 && t - S.zh[last].end <= LINGER_SECONDS;
    const idx = active >= 0 ? active : lingering ? last : -1;
    // The line we're in or just after; an open explanation belongs to it and
    // stays through the silence until the next line starts.
    const anchor = active >= 0 ? active : last;
    const anchorChanged = anchor !== S.anchor;
    S.anchor = anchor;
    lines.classList.toggle('zimu-past', active < 0);
    if (idx === S.shown && !force) {
      if (anchorChanged) syncExplain();
      return;
    }
    S.shown = idx;
    const cue = S.zh[idx];
    renderZh(cue);
    renderEn(idx);
    syncExplain();
  }

  // ---- playback loop -------------------------------------------------------

  const LINGER_SECONDS = 3;

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
    if (S.settings.autoPause && !v.paused && S.zh.length && !isOff()) {
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

  // Plays from the estimated moment code points [from, to) of cue i are
  // spoken (with a little lead-in). stopAfter: pause just after them (the
  // ▶ Hear it button); otherwise playback carries on and auto-pause, if on,
  // stops it at the end of the line as usual (clicking a word).
  function playSpan(i, from, to, { stopAfter = false } = {}) {
    const cue = S.zh[i];
    if (!cue || from == null) return;
    const est = Z.estimateSpan(cue.zhText, from, to, cue.start, cue.end);
    const a = Math.max(cue.start - 0.1, est.start - 0.35);
    if (stopAfter) {
      S.autoPausedIdx = i; // auto-pause mustn't cut the clip at the line's end
      S.clipEnd = Math.min(cue.end + 0.2, est.end + 0.35);
    } else {
      S.autoPausedIdx = -1;
      S.clipEnd = null;
    }
    seek(a);
  }

  const clampSpeed = (n) => Math.max(60, Math.min(100, Math.round(n)));

  function applySpeed() {
    const v = S.video;
    if (!v) return;
    v.preservesPitch = true; // slow the speech without lowering the voice
    const rate = isOff() || noLines() ? 1 : clampSpeed(S.settings.speed) / 100;
    if (Math.abs(v.playbackRate - rate) > 0.001) v.playbackRate = rate;
  }

  // Settings changed by dragging or key-repeat apply at once and are saved
  // once the adjusting stops, so storage echoes of earlier values can't
  // undo newer ones.
  const pendingSave = {};
  let saveTimer = 0;
  function setLocal(key, value) {
    S.settings[key] = value;
    pendingSave[key] = value;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const patch = { ...pendingSave };
      Z.Settings.set(patch).finally(() => {
        for (const k of Object.keys(patch)) if (pendingSave[k] === patch[k]) delete pendingSave[k];
      });
    }, 400);
  }

  function setSpeed(n) {
    const speed = clampSpeed(n);
    setLocal('speed', speed);
    applySpeed();
    paintSpeed(speed);
    setStatus(`Speed ${speed}%`, 1500);
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
    const pyLine = cue.zhText.split('\n').map((l) => tokenize(l).map((t) => (t.han ? tokenPinyin(t) : t.text.trim())).filter(Boolean).join(' ')
      .replace(/\s+([，。！？、；：,.!?;:…）」』”])/g, '$1')).join(' / ');
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

  // tok.from/to: position in the shown cue (absent for looked-up characters
  // that aren't from the line).
  function wordPopup(tok, anchorRect, { autoplay = false } = {}) {
    const word = tok.text;
    const ctxPinyin = tokenPinyin(tok);
    const entries = S.dict ? S.dict.lookup(word) : [];
    const chars = tok.chars.length > 1 ? h('div', { class: 'zimu-chars' }, tok.chars.map((c, k) => {
      const ce = S.dict ? S.dict.lookup(c)[0] : null;
      const sub = { text: c, chars: [c], py: [tok.py[k]], from: tok.from != null ? tok.from + k : null, to: tok.from != null ? tok.from + k + 1 : null };
      return h('div', { class: 'zimu-char', title: 'Look up', onclick: () => wordPopup(sub, anchorRect) },
        h('span', { class: 'zimu-char-h' }, c), h('span', { class: 'zimu-char-py' }, tok.py[k]),
        h('span', { class: 'zimu-muted' }, ce ? ce.defs.slice(0, 2).join('; ') : ''));
    })) : null;
    const shownIdx = S.shown;
    const hear = tok.from != null
      ? h('button', { class: 'zimu-btn', title: 'Play where it’s said (estimated)', onclick: () => playSpan(shownIdx, tok.from, tok.to, { stopAfter: true }) }, '▶ Hear it')
      : null;
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
        hear,
        h('button', { class: 'zimu-btn', onclick: () => gotoLine('repeat') }, '↻ Replay line'))),
    anchorRect);
    if (autoplay && hear && S.settings.playWordOnClick) playSpan(shownIdx, tok.from, tok.to);
  }

  function phrasePopup(toks, anchorRect, span, { autoplay = false } = {}) {
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
        h('button', { class: 'zimu-btn', title: 'Play where it’s said (estimated)', onclick: () => playSpan(shownIdx, span.from, span.to, { stopAfter: true }) }, '▶ Hear it'),
        h('button', { class: 'zimu-btn', onclick: () => gotoLine('repeat') }, '↻ Replay line'))),
    anchorRect);
    if (autoplay && S.settings.playWordOnClick) playSpan(shownIdx, span.from, span.to);
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
    S.suppressClick = true; // the click that follows belongs to this word/phrase pick
    setTimeout(() => { S.suppressClick = false; }, 0);
    const { a, b } = S.sel;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const els = [...zhBox.querySelectorAll('.zimu-sel')];
    const rect = els.length ? unionRect(els) : e.target.getBoundingClientRect();
    if (lo === hi) wordPopup(S.tokens[lo], rect, { autoplay: true });
    else phrasePopup(phraseTokens(lo, hi), rect, { from: S.tokens[lo].from, to: S.tokens[hi].to }, { autoplay: true });
  }, true);
  // Swallow clicks on the overlay so Jellyfin doesn't toggle play/pause.
  root.addEventListener('click', (e) => e.stopPropagation());
  // Jellyfin turns the volume with the mouse wheel anywhere on the page;
  // scrolling inside one of our panels must only scroll the panel.
  root.addEventListener('wheel', (e) => {
    if (e.target.closest && e.target.closest('.zimu-explain, .zimu-popup, .zimu-panel')) e.stopPropagation();
  }, { passive: true });
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

  // ---- sentence explanations (hover the box, not a word) -------------------

  let explainPanel = null;

  // FNV-1a, for cache keys.
  function hash(str) {
    let x = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
    return x.toString(16).padStart(8, '0');
  }

  // Plain text with **bold** and "- " bullets → DOM (never innerHTML).
  function renderExplanation(el, text) {
    el.textContent = '';
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd();
      if (!line.trim()) continue;
      const bullet = /^\s*[-•*]\s+/.test(line);
      const row = h('div', { class: bullet ? 'zimu-x-bullet' : 'zimu-x-para' });
      line.replace(/^\s*[-•*]\s+/, '').split(/(\*\*[^*]+\*\*)/).forEach((part) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) row.append(h('b', null, part.slice(2, -2)));
        else if (part) row.append(part);
      });
      el.append(row);
    }
  }

  // Clicking the subtitle box (not a word) explains the line. The panel stays
  // up while its line is on screen: playback, word popups and mouse movement
  // don't close it; a different line does, and coming back to an explained
  // line shows it again (from the saved copy). × / Esc dismiss it for good —
  // it only comes back when the line is clicked again.

  const explainJobs = new Map(); // key → { text, state, cached, error, subs }

  function explainKey(i) {
    const cue = S.zh[i];
    return cue ? hash(`${S.itemId}|${cue.start.toFixed(2)}|${cue.zhText}`) : null;
  }

  function closeExplain() {
    if (explainPanel) {
      if (explainPanel.unsub) explainPanel.unsub();
      explainPanel.remove();
      explainPanel = null;
    }
  }

  function dismissExplain() {
    if (explainPanel) {
      const key = explainPanel.dataset.key;
      S.dismissedKeys.add(key);
      Z.Sentences.setDismissed(key, true); // remembered with the saved sentence
    }
    closeExplain();
  }

  const EXPLAIN_ERRORS = {
    badkey: 'Anthropic didn’t accept the API key. Check it in Zimu’s settings.',
    rate: 'Rate-limited by Anthropic. Try again in a moment.',
    network: 'Couldn’t reach Anthropic.',
    refusal: 'Claude declined to explain this line.',
  };

  // One request per line at a time; a panel reopened mid-stream just
  // subscribes to the running job.
  function explainJob(i, key) {
    if (explainJobs.has(key)) return explainJobs.get(key);
    const job = { text: '', state: 'running', cached: false, error: null, subs: new Set() };
    explainJobs.set(key, job);
    const notify = () => job.subs.forEach((fn) => fn());
    const finish = () => { explainJobs.delete(key); notify(); };
    (async () => {
      const cue = S.zh[i];
      const sentence = await sentenceFor(i);
      const neighbours = (from, to) => S.zh.slice(Math.max(0, from), Math.max(0, to)).map((c) => c.zhText.replace(/\n/g, ' '));
      const port = chrome.runtime.connect({ name: 'explain' });
      port.onMessage.addListener((m) => {
        if (m.type === 'delta') {
          job.text += m.text;
          notify();
        } else if (m.type === 'done') {
          Object.assign(job, { text: m.text, state: 'done', cached: !!m.cached });
          port.disconnect();
          finish();
        } else if (m.type === 'error') {
          Object.assign(job, { state: 'error', error: m });
          port.disconnect();
          finish();
        }
      });
      port.postMessage({
        key,
        title: S.title,
        line: cue.zhText.replace(/\n/g, ' '),
        pinyin: sentence ? sentence.pinyin : '',
        english: sentence ? sentence.en : '',
        englishSource: typeof S.enMode === 'number' || S.enMode === 'embedded' ? 'subtitle' : 'mt',
        before: neighbours(i - 2, i),
        after: neighbours(i + 1, i + 3),
        source: cueSource(i),
      });
    })().catch((e) => {
      Object.assign(job, { state: 'error', error: { code: 'api', message: String(e.message || e) } });
      finish();
    });
    return job;
  }

  function openExplain(i, { pause = false } = {}) {
    const cue = S.zh[i];
    const key = explainKey(i);
    if (!cue || !key) return;
    closeExplain();
    if (S.dismissedKeys.delete(key) || pause) Z.Sentences.setDismissed(key, false);
    if (pause && S.video && !S.video.paused) S.video.pause();

    const body = h('div', { class: 'zimu-x-body' });
    const foot = h('div', { class: 'zimu-x-foot' },
      h('button', { class: 'zimu-btn', title: 'Replay this line (S)', onclick: () => gotoLine('repeat') }, '↻ Replay line'),
      h('span', { class: 'zimu-muted zimu-x-status' }));
    const pinyin = cue.zhText.split('\n').map((l) => tokenize(l).filter((t) => t.han).map(tokenPinyin).join(' ')).join(' / ');
    const panelEl = h('div', { class: 'zimu-explain', 'data-cue': i, 'data-key': key, onmousedown: (e) => e.stopPropagation() },
      h('button', { class: 'zimu-x', title: 'Close (Esc)', onclick: () => dismissExplain() }, '×'),
      h('div', { class: 'zimu-x-line' }, cue.zhText.replace(/\n/g, ' ')),
      h('div', { class: 'zimu-x-py' }, pinyin),
      body, foot);
    explainPanel = panelEl;
    root.append(panelEl);

    const job = explainJob(i, key);
    const status = foot.querySelector('.zimu-x-status');
    const paint = () => {
      if (job.state === 'error') {
        body.textContent = '';
        const m = job.error || {};
        if (m.code === 'nokey') {
          body.append(
            h('div', null, 'Sentence explanations need an Anthropic API key.'),
            h('button', { class: 'zimu-save', onclick: () => send({ type: 'openCards', view: 'settings' }) }, 'Open Zimu settings'));
        } else {
          body.append(EXPLAIN_ERRORS[m.code] || `Explanation failed: ${m.message || m.code}`);
        }
        status.textContent = '';
        return;
      }
      if (job.text) renderExplanation(body, job.text);
      else body.replaceChildren(h('span', { class: 'zimu-muted' }, 'Thinking…'));
      status.textContent = job.state === 'done' ? '★ Saved to Sentences' : '';
    };
    job.subs.add(paint);
    panelEl.unsub = () => job.subs.delete(paint);
    paint();
  }

  // Called when the line on screen changes: drop a panel for another line,
  // and bring back the saved explanation of an already-explained one.
  async function syncExplain() {
    const i = S.anchor;
    if (explainPanel && Number(explainPanel.dataset.cue) !== i) closeExplain();
    if (i < 0 || explainPanel || !S.settings.explainOnHover || isOff()) return;
    const key = explainKey(i);
    if (!key || S.dismissedKeys.has(key)) return;
    let known = explainJobs.has(key);
    if (!known) {
      const saved = await Z.Sentences.get(key);
      known = !!saved && !saved.dismissed;
    }
    if (known && S.anchor === i && !explainPanel && !S.dismissedKeys.has(key)) openExplain(i);
  }

  // A click on the box that isn't on a word (the English line, punctuation,
  // the space around the words) explains the line.
  lines.addEventListener('click', (e) => {
    if (!S.settings.explainOnHover || S.shown < 0 || S.suppressClick) return;
    if (e.target.closest && e.target.closest('.zimu-w')) return;
    if (explainPanel && Number(explainPanel.dataset.cue) === S.shown) return;
    openExplain(S.shown, { pause: true });
  });

  document.addEventListener('mousedown', (e) => {
    if (popup && !popup.contains(e.target)) closePopup();
    if (panel && !panel.contains(e.target) && !toolbar.contains(e.target) && !osdGroup.contains(e.target)) togglePanel(false);
  }, true);

  // ---- settings panel ------------------------------------------------------

  // anchor: the button it opens from (Jellyfin's bar); the panel sits above it.
  function togglePanel(force, anchor) {
    const open = force ?? !panel;
    if (anchor) S.panelAnchor = anchor;
    if (panel) { panel.remove(); panel = null; }
    if (!open) return;
    const st = S.settings;
    const check = (key, label) => h('label', { class: 'zimu-check' },
      h('input', { type: 'checkbox', checked: !!st[key], onchange: (e) => Z.Settings.set({ [key]: e.target.checked }) }), label);
    const zhOpts = S.subs.filter((s) => s.text);
    const off = isOff();
    const zhSel = h('select', { onchange: (e) => {
      const v = e.target.value;
      e.target.blur(); // so Z and the other keys work straight away
      if (v === 'off') return setOff(true);
      setOff(false);
      if (Number(v) !== S.zhTrack) chooseTracks(Number(v), 'auto');
    } },
    zhOpts.length ? h('option', { value: 'off', selected: off }, 'Off for this show (Z)') : h('option', null, 'No text subtitles'),
    zhOpts.map((s) => h('option', { value: s.index, selected: !off && s.index === S.zhTrack }, s.title)));
    const enSel = h('select', { onchange: (e) => {
      const v = e.target.value;
      chooseTracks(S.zhTrack, /^\d+$/.test(v) ? Number(v) : v);
    } },
    h('option', { value: 'embedded', selected: S.enMode === 'embedded' }, 'From the Chinese track (bilingual)'),
    h('option', { value: 'mt', selected: S.enMode === 'mt' }, 'Machine translation'),
    h('option', { value: 'none', selected: S.enMode === 'none' }, 'None'),
    zhOpts.map((s) => h('option', { value: s.index, selected: s.index === S.enMode }, s.title)));
    const range = (key, label, min, max, unit = '') => {
      const text = h('span', null, `${label} ${st[key]}${unit}`);
      return h('label', { class: 'zimu-range' }, text,
        h('input', { type: 'range', min, max, value: st[key], oninput: (e) => {
          const v = Number(e.target.value);
          text.textContent = `${label} ${v}${unit}`;
          setLocal(key, v);
          applySettings();
        } }));
    };
    panel = h('div', { class: 'zimu-panel', onmousedown: (e) => e.stopPropagation() },
      h('div', { class: 'zimu-panel-title' }, 'Show'),
      h('div', { class: 'zimu-row-flex' }, check('showHanzi', 'Hanzi'), check('showPinyin', 'Pinyin'), check('showEnglish', 'English')),
      h('div', { class: 'zimu-panel-title' }, 'Tracks'),
      h('label', { class: 'zimu-field' }, 'Chinese', zhSel),
      h('label', { class: 'zimu-field' }, 'English', enSel),
      h('div', { class: 'zimu-panel-title' }, 'Behaviour'),
      check('playWordOnClick', 'Play from a word when I click it'),
      check('explainOnHover', 'Explain the sentence when I click the box (not a word)'),
      check('pauseOnHover', 'Pause while the mouse is over the subtitles'),
      check('autoPause', 'Pause at the end of each line (Q)'),
      check('hideNativeSubs', 'Hide Jellyfin’s own subtitles'),
      check('toneColors', 'Colour by tone'),
      check('machineTranslate', 'Machine-translate when there is no English track'),
      h('div', { class: 'zimu-panel-title' }, 'Look'),
      range('textOpacity', 'Text', 30, 100, '%'),
      range('bgOpacity', 'Background', 0, 100, '%'),
      range('fontSize', 'Size', 18, 64, 'px'),
      range('bottom', 'Height', 2, 60, '%'),
      h('div', { class: 'zimu-muted' }, 'Keys: Z on/off · A previous · S repeat · D next · Q auto-pause · [ ] speed ±1% ({ } ±5%) · Esc close'));
    root.append(panel);
    const a = S.panelAnchor;
    if (a && a.isConnected) {
      const r = a.getBoundingClientRect();
      panel.classList.add('zimu-panel-osd');
      panel.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
      panel.style.bottom = `${window.innerHeight - r.top + 8}px`;
    }
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
      if (reason === 'start') setStatus('Zimu couldn’t find what Jellyfin is playing', 0);
    } finally {
      S.syncing = false;
    }
  }

  async function loadItem(itemId, mediaSourceId) {
    setStatus('Zimu: finding subtitles…', 0);
    closeExplain();
    S.itemId = itemId;
    S.zh = [];
    S.en = [];
    S.subs = [];
    S.zhTrack = null;
    S.showKey = null;
    S.shown = -2;
    S.autoPausedIdx = -1;
    applySettings();
    try {
      S.item = await J.item(itemId);
    } catch (e) {
      setStatus(`Zimu: ${e.message || e}`, 0);
      return;
    }
    S.title = J.itemTitle(S.item);
    S.showKey = S.item.SeriesId || S.item.Id;
    const { mediaSourceId: msId, subs } = J.subtitleStreams(S.item, mediaSourceId);
    S.mediaSourceId = msId;
    S.subs = subs;
    const { zh, en } = J.pickTracks(subs.slice());
    if (!zh) {
      setStatus(subs.length ? 'No Chinese subtitle track on this video (⚙ to pick one)' : 'This video has no subtitles', 0);
      applySettings();
      return;
    }
    if (!zh.text) {
      setStatus('The Chinese subtitles are images (PGS/VobSub); Zimu needs text (SRT/ASS)', 0);
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
      if (isOff()) setStatus('', 0);
      else setStatus(S.zh.length ? `${S.zh.length} lines · ${S.title}` : 'That track has no Chinese text', 4000);
      loadDict();
      applySettings();
      if (S.pendingClip && S.pendingClip.itemId === itemId) startPendingClip();
    } catch (e) {
      console.error('[zimu]', e);
      setStatus(`Subtitles failed: ${e.message || e}`, 0);
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
      paintPlay();
      // someone pressed play while we were holding: stop holding
      if (S.holds.size) { S.holds.clear(); S.weePaused = false; }
      kick();
    },
    loadedmetadata: () => applySpeed(),
    playing: () => {
      applySpeed();
      if (!S.itemId || Date.now() - S.lastSync > 3000) syncNowPlaying('start');
      if (S.pendingClip && S.pendingClip.itemId === S.itemId && S.zh.length) startPendingClip();
      kick();
    },
    loadstart: () => { S.itemId = null; S.zh = []; S.shown = -2; applySettings(); },
    seeking: () => {
      if (!S.ourSeek) { S.clipEnd = null; }
      S.ourSeek = false;
      S.autoPausedIdx = -1;
      kick();
    },
    seeked: () => kick(),
    pause: () => { paintPlay(); kick(); },
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
    paintPlay();
    mountOsd();
  }

  function detach() {
    if (!S.video) return;
    for (const [ev, fn] of Object.entries(videoEvents)) S.video.removeEventListener(ev, fn);
    S.video = null;
    S.itemId = null;
    S.zh = [];
    S.zhTrack = null;
    S.showKey = null;
    S.holds.clear();
    closePopup();
    closeExplain();
    togglePanel(false);
    root.classList.add('zimu-hidden');
    document.documentElement.classList.remove('zimu-hide-native');
  }

  function findVideo() {
    const v = document.querySelector('video.htmlvideoplayer') ||
      [...document.querySelectorAll('video')].find((x) => x.getBoundingClientRect().width > 200);
    return v && v.isConnected ? v : null;
  }

  // Hand the borrowed Jellyfin login to the background so flashcards can
  // sync through this server (also from the flashcard page).
  let sentAuth = '';
  function shareAuth() {
    const c = J.credentials();
    if (!c) return;
    const sig = `${c.base}|${c.userId}|${c.token}`;
    if (sig === sentAuth) return;
    sentAuth = sig;
    send({ type: 'jellyfinAuth', server: c.base, token: c.token, userId: c.userId });
  }

  setInterval(() => {
    shareAuth();
    const v = findVideo();
    if (v && J.credentials()) attach(v); else if (!v) detach();
    if (S.video) {
      // lift the subtitles above Jellyfin's control bar while it shows
      const osd = document.querySelector('.videoOsdBottom');
      const visible = osd && !osd.classList.contains('videoOsdBottom-hidden') && osd.getBoundingClientRect().height > 0 &&
        getComputedStyle(osd).opacity !== '0';
      root.style.setProperty('--zimu-lift', visible ? `${Math.round(osd.getBoundingClientRect().height)}px` : '0px');
      mountOsd();
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
    const sp = S.settings.speed;
    const act = k === 'z' ? (S.showKey && S.zh.length ? () => setOff(!isOff()) : null) : isOff() || noLines() ? null : {
      a: () => gotoLine('prev'), s: () => gotoLine('repeat'), d: () => gotoLine('next'), q: toggleAutoPause,
      '[': () => setSpeed(sp - 1), ']': () => setSpeed(sp + 1), '{': () => setSpeed(sp - 5), '}': () => setSpeed(sp + 5),
    }[k];
    if (e.key === 'Escape' && (popup || panel)) { closePopup(); togglePanel(false); }
    else if (e.key === 'Escape' && explainPanel) dismissExplain();
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
      // values still waiting to save are newer than this echo
      S.settings = { ...Z.DEFAULT_SETTINGS, ...changes.settings.newValue, ...pendingSave };
      applySettings();
      if (panel && !panel.contains(document.activeElement)) { togglePanel(false); togglePanel(true); }
    }
  });
  window.addEventListener('hashchange', checkHashClip);
  checkHashClip();
})();

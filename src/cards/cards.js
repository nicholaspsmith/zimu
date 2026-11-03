'use strict';
const Z = globalThis.Zimu;
const $ = (id) => document.getElementById(id);

let cards = [];
let queue = [];
let current = null;
const viewFromHash = () => ({ '#list': 'list', '#sentences': 'sentences', '#settings': 'settings' })[location.hash] || 'review';
let view = viewFromHash();

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// Sentence with the card's word highlighted.
function highlighted(sentence, word) {
  const frag = document.createDocumentFragment();
  if (!sentence) return frag;
  const parts = word ? sentence.split(word) : [sentence];
  parts.forEach((p, i) => {
    frag.append(p);
    if (i < parts.length - 1) frag.append(h('mark', null, word));
  });
  return frag;
}

const sourceLabel = (c) => (c.source ? `${c.source.title || 'Jellyfin'} @ ${Z.formatTime(c.source.start)}` : '');

async function play(card) {
  if (!card || !card.source) return toast('This card has no video moment.');
  const r = await chrome.runtime.sendMessage({ type: 'playClip', source: card.source });
  if (!r || !r.ok) toast(`Couldn’t play: ${(r && r.error) || 'no response'}`);
  else if (r.opened) toast('Opening Jellyfin…');
}

// ---- review --------------------------------------------------------------

function buildQueue() {
  const now = Date.now();
  queue = cards.filter((c) => Z.isDue(c, now)).sort((a, b) => (a.due || 0) - (b.due || 0));
}

function showNext() {
  current = queue.shift() || null;
  $('review-empty').hidden = !!current;
  $('review-card').hidden = !current;
  if (!current) return;
  const c = current;
  $('r-hanzi').textContent = c.hanzi;
  $('r-sentence').replaceChildren(highlighted(c.sentence && c.sentence.zh, c.hanzi));
  $('r-pinyin').textContent = c.pinyin || '';
  $('r-english').textContent = c.english || '';
  $('r-sentence-py').textContent = (c.sentence && c.sentence.pinyin) || '';
  $('r-sentence-en').textContent = (c.sentence && c.sentence.en) || '';
  $('r-source').textContent = sourceLabel(c);
  $('r-play').hidden = !c.source;
  $('r-back').hidden = true;
  $('r-grades').hidden = true;
  $('r-show').hidden = false;
}

function reveal() {
  if (!current) return;
  $('r-back').hidden = false;
  $('r-grades').hidden = false;
  $('r-show').hidden = true;
}

async function grade(g) {
  if (!current || $('r-grades').hidden) return;
  const next = Z.schedule(current, g);
  const id = current.id;
  if (g === 'again') queue.push({ ...current, ...next }); // see it again this session
  await Z.Cards.update(id, { ...next, reviewed: Date.now() });
  showNext();
}

// ---- list ----------------------------------------------------------------

function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const match = (c) => !q || [c.hanzi, c.trad, c.pinyin, c.english, c.sentence && c.sentence.zh]
    .some((x) => x && String(x).toLowerCase().includes(q));
  const rows = cards.filter(match).sort((a, b) => b.created - a.created);
  $('rows').replaceChildren(...rows.map((c) => h('tr', null,
    h('td', { class: 'hanzi-cell' }, c.hanzi, c.trad ? h('span', { class: 'muted' }, ` ${c.trad}`) : null),
    h('td', { class: 'pinyin' }, c.pinyin || ''),
    h('td', null, c.english || '', c.sentence && c.sentence.zh ? h('div', { class: 'muted small' }, c.sentence.zh) : null),
    h('td', { class: 'from' }, c.source
      ? h('button', { class: 'play', title: 'Play this moment in Jellyfin', onclick: () => play(c) }, '▶ ', sourceLabel(c))
      : ''),
    h('td', null, h('button', { class: 'ghost', title: 'Delete card', onclick: async () => {
      await Z.Cards.remove(c.id);
      toast(`Deleted ${c.hanzi}`);
    } }, '🗑')))));
  $('list-empty').hidden = rows.length > 0;
}

// ---- export / import -------------------------------------------------------

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 10);
const tsv = (s) => String(s || '').replace(/[\t\r\n]+/g, ' ');

function exportAnki() {
  const lines = [
    '#separator:tab',
    '#html:false',
    '#columns:Hanzi\tPinyin\tEnglish\tSentence\tSentence pinyin\tSentence English\tSource\tLink',
  ];
  for (const c of cards) {
    lines.push([
      c.hanzi, c.pinyin, c.english,
      c.sentence && c.sentence.zh, c.sentence && c.sentence.pinyin, c.sentence && c.sentence.en,
      sourceLabel(c), c.source ? Z.clipUrl(c.source) : '',
    ].map(tsv).join('\t'));
  }
  download(`zimu-anki-${stamp()}.txt`, lines.join('\n') + '\n', 'text/tab-separated-values');
}

function exportJson() {
  download(`zimu-cards-${stamp()}.json`, JSON.stringify({ version: 1, cards }, null, 2), 'application/json');
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data.cards;
    if (!Array.isArray(incoming)) throw new Error('no cards in file');
    const byHanzi = new Map(cards.map((c) => [c.hanzi, c]));
    let added = 0;
    for (const c of incoming) {
      if (!c || !c.hanzi || byHanzi.has(c.hanzi)) continue;
      byHanzi.set(c.hanzi, { ...c, updated: Date.now() }); // newer than any old deletion
      added++;
    }
    await Z.Cards.replaceAll([...byHanzi.values()]);
    toast(`Restored ${added} new card${added === 1 ? '' : 's'}`);
  } catch (e) {
    toast(`Restore failed: ${e.message}`);
  }
}

// ---- site access ------------------------------------------------------------
// Zen/Firefox treat host permissions as optional and don't grant ones added
// by an update, so the page asks for whatever is missing.

let missingOrigins = [];

async function checkPermissions() {
  const wanted = chrome.runtime.getManifest().host_permissions || [];
  const missing = [];
  for (const origin of wanted) {
    if (!(await chrome.permissions.contains({ origins: [origin] }))) missing.push(origin);
  }
  missingOrigins = missing;
  $('perm-sites').textContent = missing.map((o) => o.replace(/^\w+:\/\/|\/\*$/g, '')).join(', ');
  $('perm-banner').hidden = missing.length === 0;
}

$('perm-grant').onclick = () => {
  // must be called straight from the click, before any await
  chrome.permissions.request({ origins: missingOrigins }).then((ok) => {
    toast(ok ? 'Access granted — reload your Jellyfin tab.' : 'Access not granted.');
    checkPermissions();
  });
};
chrome.permissions.onAdded.addListener(checkPermissions);
chrome.permissions.onRemoved.addListener(checkPermissions);
checkPermissions();

// ---- sync between Macs (through Jellyfin) ------------------------------------

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

async function paintSync() {
  const { syncStatus: st } = await chrome.storage.local.get('syncStatus');
  const el = $('sync-status');
  if (!st) { el.textContent = ''; return; }
  el.textContent = st.ok ? `Synced ${ago(st.at)}` : `Sync: ${st.error}`;
  el.title = st.ok ? `${st.cards} cards, ${st.sentences} sentences on the Jellyfin server` : '';
  el.classList.toggle('sync-error', !st.ok);
}

$('sync-now').onclick = async () => {
  $('sync-now').disabled = true;
  $('sync-status').textContent = 'Syncing…';
  await chrome.runtime.sendMessage({ type: 'syncNow' });
  $('sync-now').disabled = false;
  paintSync();
};
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.syncStatus) paintSync(); });
setInterval(paintSync, 30000);
paintSync();
chrome.runtime.sendMessage({ type: 'syncNow' }); // pick up the other Mac's changes on open

// ---- wiring ----------------------------------------------------------------

function setView(v) {
  view = v;
  history.replaceState(null, '', `#${v}`);
  for (const name of ['review', 'list', 'sentences', 'settings']) {
    $(name).hidden = v !== name;
    $(`tab-${name}`).classList.toggle('active', v === name);
  }
  if (v === 'review') { buildQueue(); showNext(); }
  else if (v === 'list') renderList();
  else if (v === 'sentences') renderSentences();
  else renderSettings();
}

// ---- sentence translations ----------------------------------------------------

let sentences = [];

// Plain text with **bold** and "- " bullets → DOM (same rules as the overlay).
function explanationNode(text) {
  const box = h('div', { class: 'explanation' });
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const bullet = /^\s*[-•*]\s+/.test(line);
    const row = h('div', { class: bullet ? 'x-bullet' : 'x-para' });
    line.replace(/^\s*[-•*]\s+/, '').split(/(\*\*[^*]+\*\*)/).forEach((part) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) row.append(h('b', null, part.slice(2, -2)));
      else if (part) row.append(part);
    });
    box.append(row);
  }
  return box;
}

async function loadSentences() {
  sentences = await Z.Sentences.all();
  $('sentence-count').textContent = sentences.length;
}

function renderSentences() {
  const q = $('sentence-search').value.trim().toLowerCase();
  const rows = sentences.filter((x) => !q || [x.line, x.pinyin, x.english, x.explanation]
    .some((v) => v && String(v).toLowerCase().includes(q)));
  $('sentence-list').replaceChildren(...rows.map((x) => h('article', { class: 'sentence-item' },
    h('div', { class: 'sentence-head' },
      h('div', { class: 'sentence-zh' }, x.line),
      h('div', { class: 'sentence-actions' },
        x.source ? h('button', { class: 'play', title: 'Play this line in Jellyfin', onclick: () => play(x) }, '▶ ', sourceLabel(x)) : null,
        h('button', { class: 'ghost', title: 'Delete', onclick: async () => {
          await Z.Sentences.remove(x.key);
          toast('Deleted');
        } }, '🗑'))),
    x.pinyin ? h('div', { class: 'sentence-py' }, x.pinyin) : null,
    x.english ? h('div', { class: 'sentence-en' }, h('span', { class: 'muted small' }, x.englishSource === 'mt' ? 'Machine translation: ' : 'Subtitle: '), x.english) : null,
    explanationNode(x.explanation))));
  $('sentences-empty').hidden = rows.length > 0 || !!q;
}

$('sentence-search').oninput = renderSentences;
Z.Sentences.onChange(async () => {
  await loadSentences();
  if (view === 'sentences') renderSentences();
});

// ---- settings: Anthropic API key ---------------------------------------------

async function renderSettings() {
  const { anthropicKey } = await chrome.storage.local.get('anthropicKey');
  $('api-key').value = '';
  $('api-key-status').textContent = anthropicKey ? `Key saved (…${anthropicKey.slice(-4)})` : 'No key saved';
}

$('api-key-save').onclick = async () => {
  const key = $('api-key').value.trim();
  if (!/^sk-ant-/.test(key)) return toast('That doesn’t look like an Anthropic API key (sk-ant-…).');
  await chrome.storage.local.set({ anthropicKey: key });
  toast('Key saved.');
  renderSettings();
};
$('api-key-remove').onclick = async () => {
  await chrome.storage.local.remove('anthropicKey');
  toast('Key removed.');
  renderSettings();
};


function updateCounts() {
  const now = Date.now();
  $('due-count').textContent = cards.filter((c) => Z.isDue(c, now)).length;
  $('total-count').textContent = cards.length;
}

$('tab-review').onclick = () => setView('review');
$('tab-list').onclick = () => setView('list');
$('tab-settings').onclick = () => setView('settings');
$('tab-sentences').onclick = () => setView('sentences');
window.addEventListener('hashchange', () => setView(viewFromHash()));
$('r-show').onclick = reveal;
$('r-play').onclick = () => play(current);
$('r-grades').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-grade]');
  if (b) grade(b.dataset.grade);
});
$('search').oninput = renderList;
$('export-anki').onclick = exportAnki;
$('export-json').onclick = exportJson;
$('import-json').onchange = (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; };

document.addEventListener('keydown', (e) => {
  if (view !== 'review' || e.metaKey || e.ctrlKey || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === ' ') { e.preventDefault(); reveal(); }
  else if (e.key === '1') grade('again');
  else if (e.key === '2') grade('good');
  else if (e.key === '3') grade('easy');
  else if (e.key.toLowerCase() === 'p') play(current);
});

Z.Cards.onChange((next) => {
  cards = next;
  updateCounts();
  if (view === 'list') renderList();
  else if (!current) { buildQueue(); showNext(); }
});

Promise.all([Z.Cards.all(), loadSentences()]).then(([all]) => {
  cards = all;
  updateCounts();
  setView(view);
});

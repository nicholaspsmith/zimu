// Background: machine translation, opening the flashcard page, and routing
// "play this clip" to a Jellyfin tab.
'use strict';

// Chrome runs this as a service worker; Firefox loads lib/core.js first via
// manifest background.scripts.
if (typeof importScripts === 'function' && !globalThis.Zimu) importScripts('lib/core.js');
const Z = globalThis.Zimu;

const CARDS_URL = chrome.runtime.getURL('cards/cards.html');
const mtCache = new Map();

// Google Translate's public web endpoint (no key). Used only for lines with
// no English subtitle and for selected phrases.
async function translate(text) {
  if (mtCache.has(text)) return mtCache.get(text);
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=en&dt=t&q=' +
    encodeURIComponent(text);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`translate ${res.status}`);
  const data = await res.json();
  const out = (data[0] || []).map((part) => part[0]).join('').trim();
  if (mtCache.size > 2000) mtCache.clear();
  mtCache.set(text, out);
  return out;
}

async function openCards() {
  const [tab] = await chrome.tabs.query({ url: CARDS_URL + '*' });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: CARDS_URL });
  }
}

// Plays a saved card's moment: reuses an open Jellyfin tab for that server
// (the content script seeks or asks the server to start the item), else
// opens one on a link the content script recognises.
async function playClip(source) {
  let pattern;
  try {
    const u = new URL(source.server);
    pattern = `${u.protocol}//${u.hostname}/*`; // match patterns carry no port
  } catch {
    throw new Error('Card has no server');
  }
  const tabs = (await chrome.tabs.query({ url: pattern }))
    .filter((t) => t.url && t.url.startsWith(source.server + '/web'));
  tabs.sort((a, b) => (b.audible ? 1 : 0) - (a.audible ? 1 : 0) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const tab of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'playClip', source });
      if (r && r.ok) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true };
      }
    } catch {
      // tab without a live content script (opened before install) — skip
    }
  }
  await chrome.tabs.create({ url: Z.clipUrl(source) });
  return { ok: true, opened: true };
}

chrome.action.onClicked.addListener(() => { openCards(); });

// After an install or update, open the flashcard page if a Jellyfin site
// isn't granted yet (Zen/Firefox), so its "Grant access" button is one
// click away.
chrome.runtime.onInstalled.addListener(async () => {
  const origins = chrome.runtime.getManifest().host_permissions || [];
  const granted = await chrome.permissions.contains({ origins });
  if (!granted) openCards();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (p) => {
    p.then((v) => sendResponse({ ok: true, ...v }), (e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // keep the channel open for the async answer
  };
  switch (msg && msg.type) {
    case 'translate': return reply(translate(msg.text).then((text) => ({ text })));
    case 'openCards': return reply(openCards().then(() => ({})));
    case 'playClip': return reply(playClip(msg.source));
    default: return false;
  }
});

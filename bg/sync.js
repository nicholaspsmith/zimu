// Keeps flashcards and sentences in step between machines through the
// Jellyfin server: they're stored as the signed-in user's "custom display
// preferences" for a client called "zimu" (the per-user key/value store
// Jellyfin's own web client keeps its settings in). Every Mac signed in to
// the same Jellyfin user sees the same set.
//
// The overlay hands over the Jellyfin login it borrows from the web client
// (server, token, user); syncs then run from here: at start-up, every few
// minutes, a few seconds after any local change, and on request.
import '../src/lib/core.js';
import '../src/lib/sync.js';

const Z = globalThis.Zimu;
const PREFS_ID = 'zimu-sync';
const CLIENT = 'zimu';
const PERIOD_MINUTES = 5;
const DEBOUNCE_MS = 3000;

let running = null; // the sync in progress
let again = false; // a change arrived during it
let timer = 0;

const store = chrome.storage.local;

async function setStatus(status) {
  await store.set({ syncStatus: { at: Date.now(), ...status } });
}

function prefsUrl(auth) {
  return `${auth.server}/DisplayPreferences/${PREFS_ID}?userId=${encodeURIComponent(auth.userId)}&client=${CLIENT}`;
}

async function jellyfin(auth, method, body) {
  const res = await fetch(prefsUrl(auth), {
    method,
    headers: {
      Authorization: `MediaBrowser Token="${auth.token}"`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Jellyfin answered ${res.status}`);
  return method === 'GET' ? res.json() : null;
}

async function readLocal() {
  const everything = await store.get(null);
  const records = {};
  for (const card of everything.cards || []) if (card && card.hanzi) records[Z.cardKey(card)] = card;
  for (const [k, v] of Object.entries(everything)) if (k.startsWith('s:') && v) records[k] = v;
  return { records, deleted: everything.deleted || {}, cardsBefore: everything.cards || [] };
}

async function writeLocal(local, merged) {
  const sets = {};
  const removes = [];
  // cards: one array, oldest first
  const cards = Object.entries(merged.records)
    .filter(([k]) => k.startsWith('c:'))
    .map(([, v]) => v)
    .sort((a, b) => (a.created || 0) - (b.created || 0));
  if (JSON.stringify(cards) !== JSON.stringify(local.cardsBefore)) sets.cards = cards;
  // sentences: one storage key each
  for (const [k, v] of Object.entries(merged.records)) {
    if (k.startsWith('s:') && JSON.stringify(v) !== JSON.stringify(local.records[k])) sets[k] = v;
  }
  for (const k of Object.keys(local.records)) {
    if (k.startsWith('s:') && !merged.records[k]) removes.push(k);
  }
  if (JSON.stringify(merged.deleted) !== JSON.stringify(local.deleted)) sets.deleted = merged.deleted;
  if (!Object.keys(sets).length && !removes.length) return 0;
  // These writes schedule one more sync like any change would; it finds
  // nothing new and stops there (no write, no upload).
  if (removes.length) await store.remove(removes);
  if (Object.keys(sets).length) await store.set(sets);
  return Object.keys(sets).length + removes.length;
}

async function syncOnce() {
  const { jellyfinAuth: auth } = await store.get('jellyfinAuth');
  if (!auth) {
    await setStatus({ ok: false, error: 'Open Jellyfin once in this browser so Zimu can sync.' });
    return;
  }
  const dto = await jellyfin(auth, 'GET');
  const remotePrefs = (dto && dto.CustomPrefs) || {};
  const remote = Z.Sync.fromPrefs(remotePrefs);
  const local = await readLocal();
  const merged = Z.Sync.merge(local, remote);
  const changedLocally = await writeLocal(local, merged);

  // keep any other values Jellyfin has under this client; replace ours
  const others = Object.fromEntries(Object.entries(remotePrefs)
    .filter(([k]) => !k.startsWith('c:') && !k.startsWith('s:') && !k.startsWith('d:') && k !== 'zimu:v'));
  const nextPrefs = { ...others, ...Z.Sync.toPrefs(merged) };
  const pushed = !Z.Sync.samePrefs(nextPrefs, remotePrefs);
  if (pushed) {
    await jellyfin(auth, 'POST', {
      ...(dto || {}),
      Id: PREFS_ID,
      Client: CLIENT,
      SortBy: (dto && dto.SortBy) || 'SortName',
      SortOrder: (dto && dto.SortOrder) || 'Ascending',
      ScrollDirection: (dto && dto.ScrollDirection) || 'Horizontal',
      CustomPrefs: nextPrefs,
    });
  }
  const cards = Object.keys(merged.records).filter((k) => k.startsWith('c:')).length;
  await setStatus({ ok: true, cards, sentences: Object.keys(merged.records).length - cards, pulled: changedLocally, pushed });
}

export function syncNow() {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await syncOnce();
      } while (again);
    } catch (e) {
      console.warn('[zimu] sync failed', e);
      await setStatus({ ok: false, error: String(e.message || e) });
    } finally {
      running = null;
    }
  })();
  return running;
}

function soon() {
  clearTimeout(timer);
  timer = setTimeout(syncNow, DEBOUNCE_MS);
}

export function startSync() {
  chrome.alarms.create('zimu-sync', { periodInMinutes: PERIOD_MINUTES });
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'zimu-sync') syncNow(); });
  chrome.runtime.onStartup.addListener(() => syncNow());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some((k) => k === 'cards' || k === 'deleted' || k.startsWith('s:'))) soon();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'jellyfinAuth') {
      const auth = { server: msg.server, token: msg.token, userId: msg.userId };
      store.get('jellyfinAuth').then(async ({ jellyfinAuth: old }) => {
        if (!old || old.server !== auth.server || old.token !== auth.token || old.userId !== auth.userId) {
          await store.set({ jellyfinAuth: auth });
        }
        syncNow();
        sendResponse({ ok: true });
      });
      return true;
    }
    if (msg.type === 'syncNow') {
      syncNow().then(() => store.get('syncStatus')).then(({ syncStatus }) => sendResponse({ ok: true, status: syncStatus }));
      return true;
    }
    return false;
  });
}

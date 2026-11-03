// Merging flashcards and sentences between machines. Pure functions: the
// background script does the storage and network work around them.
//
// Every synced thing is a record under a key: "c:<hanzi>" for a card (one
// card per headword), "s:<hash>" for an explained sentence. A deletion is a
// tombstone: key → time deleted. For each key the newest change wins, and a
// record survives a tombstone only if it changed after the deletion.
(function (root) {
  'use strict';
  const Z = root.Zimu || (root.Zimu = {});

  const TOMBSTONE_DAYS = 180;

  // When a record last changed. Older records have no `updated`; their
  // creation or last review is the best we know.
  function updatedOf(rec) {
    if (!rec) return 0;
    return rec.updated || Math.max(rec.created || 0, rec.reviewed || 0);
  }

  // Deterministic choice between two versions, so every machine picks the
  // same one: newer wins; on a tie, the larger JSON.
  function newer(a, b) {
    if (!a) return b;
    if (!b) return a;
    const ua = updatedOf(a);
    const ub = updatedOf(b);
    if (ua !== ub) return ua > ub ? a : b;
    return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
  }

  // local/remote: { records: {key: rec}, deleted: {key: ms} } → merged, same shape.
  function merge(local, remote, now = Date.now()) {
    const records = {};
    const deleted = {};
    const keys = new Set([
      ...Object.keys(local.records), ...Object.keys(remote.records),
      ...Object.keys(local.deleted), ...Object.keys(remote.deleted),
    ]);
    const oldest = now - TOMBSTONE_DAYS * 24 * 3600 * 1000;
    for (const k of keys) {
      const rec = newer(local.records[k], remote.records[k]);
      const del = Math.max(local.deleted[k] || 0, remote.deleted[k] || 0);
      if (rec && updatedOf(rec) > del) records[k] = rec;
      else if (del && del > oldest) deleted[k] = del;
    }
    return { records, deleted };
  }

  // Jellyfin keeps them as string key/values ("custom prefs").
  function toPrefs(state) {
    const prefs = { 'zimu:v': '1' };
    for (const [k, rec] of Object.entries(state.records)) prefs[k] = JSON.stringify(rec);
    for (const [k, t] of Object.entries(state.deleted)) prefs[`d:${k}`] = String(t);
    return prefs;
  }

  function fromPrefs(prefs) {
    const records = {};
    const deleted = {};
    for (const [k, v] of Object.entries(prefs || {})) {
      if (v == null) continue;
      if (k.startsWith('d:')) {
        const t = Number(v);
        if (Number.isFinite(t)) deleted[k.slice(2)] = t;
      } else if (k.startsWith('c:') || k.startsWith('s:')) {
        try { records[k] = JSON.parse(v); } catch { /* skip a damaged entry */ }
      }
    }
    return { records, deleted };
  }

  // Same content? (key order inside records doesn't matter for the prefs
  // because each record is serialised by the same code on both ends.)
  function samePrefs(a, b) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
  }

  Z.Sync = { updatedOf, merge, toPrefs, fromPrefs, samePrefs, TOMBSTONE_DAYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = Z;
})(typeof globalThis !== 'undefined' ? globalThis : this);

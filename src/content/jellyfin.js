// Minimal Jellyfin API client that borrows the web client's own login from
// localStorage (same origin), so Zimu needs no separate sign-in.
(function (root) {
  'use strict';
  const Z = root.Zimu || (root.Zimu = {});

  function serverBase() {
    // Jellyfin web lives at <base>/web/; base may include a path prefix.
    const i = location.pathname.indexOf('/web/');
    const prefix = i >= 0 ? location.pathname.slice(0, i) : '';
    return location.origin + prefix;
  }

  function credentials() {
    let data;
    try {
      data = JSON.parse(localStorage.getItem('jellyfin_credentials') || 'null');
    } catch {
      return null;
    }
    const servers = ((data && data.Servers) || []).filter((s) => s.AccessToken && s.UserId);
    if (!servers.length) return null;
    const host = location.host;
    const sameHost = (s) => [s.ManualAddress, s.LocalAddress, s.RemoteAddress]
      .some((a) => { try { return a && new URL(a).host === host; } catch { return false; } });
    servers.sort((a, b) => (b.DateLastAccessed || 0) - (a.DateLastAccessed || 0));
    const s = servers.find(sameHost) || servers[0];
    return {
      base: serverBase(),
      token: s.AccessToken,
      userId: s.UserId,
      deviceId: localStorage.getItem('_deviceId2') || '',
    };
  }

  async function api(path, opts = {}) {
    const c = credentials();
    if (!c) throw new Error('Not signed in to Jellyfin');
    const res = await fetch(c.base + path, {
      method: opts.method || 'GET',
      headers: { Authorization: `MediaBrowser Token="${c.token}"`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Jellyfin ${res.status} for ${path.split('?')[0]}`);
    const type = res.headers.get('content-type') || '';
    return type.includes('json') ? res.json() : res.text();
  }

  // This browser tab's playback session. The web client registers itself
  // under its device id; failing that, take this user's web session whose
  // position is closest to the video's.
  async function mySession(currentTime) {
    const c = credentials();
    if (!c) return null;
    if (c.deviceId) {
      const list = await api(`/Sessions?deviceId=${encodeURIComponent(c.deviceId)}`);
      const s = (list || []).find((x) => x.DeviceId === c.deviceId && x.UserId === c.userId);
      if (s) return s;
    }
    const list = (await api('/Sessions?activeWithinSeconds=300')) || [];
    const mine = list.filter((x) => x.UserId === c.userId && /web/i.test(x.Client || ''));
    if (currentTime != null) {
      const dist = (x) => (x.NowPlayingItem && x.PlayState
        ? Math.abs((x.PlayState.PositionTicks || 0) / 1e7 - currentTime) : Infinity);
      mine.sort((a, b) => dist(a) - dist(b));
    }
    return mine[0] || null;
  }

  async function item(itemId) {
    const c = credentials();
    return api(`/Items/${encodeURIComponent(itemId)}?userId=${encodeURIComponent(c.userId)}`);
  }

  async function subtitleCues(itemId, mediaSourceId, index) {
    const json = await api(`/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(mediaSourceId)}` +
      `/Subtitles/${index}/Stream.js`);
    return Z.cuesFromJellyfin(typeof json === 'string' ? JSON.parse(json) : json);
  }

  // Asks the server to tell this tab's web client to play an item from a
  // position — the same path a phone uses to cast to the browser.
  async function playOnThisClient(itemId, seconds, mediaSourceId) {
    const s = await mySession();
    if (!s) throw new Error('Jellyfin session not ready');
    const q = new URLSearchParams({
      playCommand: 'PlayNow',
      itemIds: itemId,
      startPositionTicks: String(Math.max(0, Math.round(seconds * 1e7))),
    });
    if (mediaSourceId) q.set('mediaSourceId', mediaSourceId);
    await api(`/Sessions/${encodeURIComponent(s.Id)}/Playing?${q}`, { method: 'POST' });
  }

  function itemTitle(it) {
    if (!it) return '';
    if (it.Type === 'Episode') {
      const se = `S${String(it.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(it.IndexNumber ?? 0).padStart(2, '0')}`;
      return `${it.SeriesName || ''} ${se} · ${it.Name || ''}`.trim();
    }
    return it.ProductionYear ? `${it.Name} (${it.ProductionYear})` : it.Name || '';
  }

  const ZH = /^(chi|zho|chs|cht|zh|cmn|yue|zh-.*)$/i;
  const ZH_TITLE = /chinese|mandarin|cantonese|中文|简|繁|國語|国语|chs|cht|zh-?(hans|hant|cn|tw|hk)/i;
  const EN = /^(eng|en|en-.*)$/i;

  function subtitleStreams(it, mediaSourceId) {
    const src = (it.MediaSources || []).find((m) => m.Id === mediaSourceId) || (it.MediaSources || [])[0];
    const streams = (src ? src.MediaStreams : it.MediaStreams) || [];
    return {
      mediaSourceId: src ? src.Id : mediaSourceId,
      subs: streams.filter((s) => s.Type === 'Subtitle').map((s) => ({
        index: s.Index,
        language: s.Language || '',
        title: s.DisplayTitle || s.Title || s.Language || `Track ${s.Index}`,
        text: s.IsTextSubtitleStream !== false,
        isChinese: ZH.test(s.Language || '') || ZH_TITLE.test(`${s.Title || ''} ${s.DisplayTitle || ''}`),
        isEnglish: EN.test(s.Language || '') || /english/i.test(s.Title || ''),
        forced: !!s.IsForced,
      })),
    };
  }

  // Best Chinese and English text tracks; prefers simplified, then full
  // (not forced) tracks.
  function pickTracks(subs) {
    const score = (s) => (s.text ? 10 : 0) + (s.forced ? -5 : 0) +
      (/simp|简|chs|hans/i.test(s.title) ? 2 : 0);
    const best = (list) => list.sort((a, b) => score(b) - score(a))[0] || null;
    return {
      zh: best(subs.filter((s) => s.isChinese)),
      en: best(subs.filter((s) => s.isEnglish && !s.isChinese)),
    };
  }

  Z.Jellyfin = {
    serverBase, credentials, api, mySession, item, subtitleCues,
    playOnThisClient, itemTitle, subtitleStreams, pickTracks,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

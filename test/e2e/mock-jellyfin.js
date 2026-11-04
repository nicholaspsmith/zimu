// A tiny fake Jellyfin: just enough API for Zimu's content script, plus a
// page with a <video class="htmlvideoplayer"> that obeys remote Play commands.
'use strict';
const http = require('http');
const fs = require('fs');

const TOKEN = 'test-token';
const USER = 'user1';
const DEVICE = 'device-abc';

const zh = [
  [0.5, 3.0, '我觉得他还没睡着。'],
  [3.5, 6.0, '你今天想去哪儿吃饭？'],
  [6.5, 9.5, '{\\an8}我们一起学习中文吧！'],
  [10.0, 13.0, '这个问题不太容易回答。'],
];
const en = [
  [0.5, 3.0, "I don't think he's asleep yet."],
  [3.5, 6.0, 'Where do you want to eat today?'],
  [6.5, 9.5, "Let's study Chinese together!"],
  [10.0, 13.0, "This question isn't easy to answer."],
];
const events = (rows) => ({ TrackEvents: rows.map(([s, e, t], i) => ({ Id: String(i), StartPositionTicks: s * 1e7, EndPositionTicks: e * 1e7, Text: t })) });

const page = (autoplay) => `<!doctype html><html><head><meta charset="utf-8"><title>Jellyfin</title>
<style>body{margin:0;background:#111} video{width:100vw;height:100vh;object-fit:contain}</style></head><body>
<div class="videoPlayerContainer"><video class="htmlvideoplayer" src="/media/test.mp4" ${autoplay ? 'autoplay' : ''} playsinline></video></div>
<!-- Jellyfin keeps earlier pages in the document, hidden; an older player page comes first -->
<div class="mainAnimatedPage hide" style="display:none"><div class="videoOsdBottom videoOsdBottom-maincontrols">
  <div class="osdControls"><div class="buttons focuscontainer-x"><button class="btnVideoOsdSettings">old settings</button></div></div>
</div></div>
<div class="videoOsdBottom videoOsdBottom-maincontrols videoOsdBottom-hidden" style="position:fixed;left:0;right:0;bottom:0;padding:8px;background:rgba(0,0,0,.6);color:#fff;font:16px system-ui">
  <div class="osdControls"><div class="buttons focuscontainer-x" style="display:flex;align-items:center;gap:6px">
    <div dir="ltr"><button class="btnPause">pause</button></div>
    <div class="osdTimeText"><span class="endsAtText"></span></div>
    <button class="btnVideoOsdSettings" title="Settings">settings</button>
    <button class="btnFullscreen">fullscreen</button>
  </div></div>
</div>
<script>
localStorage.setItem('_deviceId2', '${DEVICE}');
localStorage.setItem('jellyfin_credentials', JSON.stringify({Servers:[{ManualAddress:location.origin,AccessToken:'${TOKEN}',UserId:'${USER}',DateLastAccessed:Date.now()}]}));
const v = document.querySelector('video');
document.addEventListener('keydown', (e) => { if (/^[0-9]$/.test(e.key)) v.currentTime = v.duration * Number(e.key) / 10; });
const report = () => fetch('/mock/state', {method:'POST', body: JSON.stringify({playing: v.currentTime > 0 || !v.paused})});
v.addEventListener('playing', report);
setInterval(async () => {
  const cmds = await (await fetch('/mock/commands')).json();
  for (const c of cmds) { v.currentTime = c.startPositionTicks / 1e7; v.play(); }
}, 300);
</script></body></html>`;

function start(port, videoPath) {
  const state = { playing: false, commands: [], log: [], claude: [], prefs: {}, prefPosts: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const p = url.pathname;
    state.log.push(`${req.method} ${p}${url.search}`);
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const authed = (req.headers.authorization || '').includes(`Token="${TOKEN}"`);

    if (p === '/web/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page(!url.searchParams.has('noautoplay')));
    }
    if (p === '/media/test.mp4') {
      const stat = fs.statSync(videoPath);
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const s = Number(range[1]);
        const e = range[2] ? Number(range[2]) : stat.size - 1;
        res.writeHead(206, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-range': `bytes ${s}-${e}/${stat.size}`, 'content-length': e - s + 1 });
        return fs.createReadStream(videoPath, { start: s, end: e }).pipe(res);
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': stat.size });
      return fs.createReadStream(videoPath).pipe(res);
    }
    if (p === '/mock/state') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { Object.assign(state, JSON.parse(b)); json(200, {}); }); return; }
    if (p === '/mock/commands') { const c = state.commands; state.commands = []; return json(200, c); }

    // a stand-in for api.anthropic.com's streaming Messages endpoint
    if (req.method === 'POST' && p === '/v1/messages') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', async () => {
        state.claude.push({ body: JSON.parse(body), apiKey: req.headers['x-api-key'] || req.headers.authorization, beta: req.headers['anthropic-beta'] });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        send('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 0 } } });
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        for (const piece of ['**Literal**: you today want go where eat rice?\n', '**Meaning**: Where do you want to eat today?\n', '**Notes**:\n- 哪儿 nǎr is the northern, erhua form of 哪里.']) {
          await new Promise((r) => setTimeout(r, 150));
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } });
        }
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } });
        send('message_stop', {});
        res.end();
      });
      return;
    }

    if (!authed) return json(401, { error: 'unauthorized' });
    if (p === '/Sessions' && url.searchParams.get('deviceId') === DEVICE) {
      return json(200, [{ Id: 'sess1', DeviceId: DEVICE, UserId: USER,
        NowPlayingItem: state.playing ? { Id: 'item1', Name: 'Pilot' } : undefined,
        PlayState: { MediaSourceId: 'ms1' } }]);
    }
    if (p === '/Items/item1') {
      return json(200, { Id: 'item1', Type: 'Episode', SeriesId: 'series1', SeriesName: '测试剧', ParentIndexNumber: 1, IndexNumber: 2, Name: 'Pilot',
        MediaSources: [{ Id: 'ms1', MediaStreams: [
          { Type: 'Video', Index: 0 }, { Type: 'Audio', Index: 1 },
          { Type: 'Subtitle', Index: 2, Language: 'chi', DisplayTitle: 'Chinese (Simplified)', IsTextSubtitleStream: true },
          { Type: 'Subtitle', Index: 3, Language: 'eng', DisplayTitle: 'English', IsTextSubtitleStream: true },
        ] }] });
    }
    // per-user custom display preferences (Zimu's sync store); POST replaces
    if (p === '/DisplayPreferences/zimu-sync' && url.searchParams.get('client') === 'zimu') {
      if (req.method === 'GET') {
        return json(200, { Id: 'zimu-sync', Client: 'zimu', SortBy: 'SortName', SortOrder: 'Ascending', ScrollDirection: 'Horizontal', CustomPrefs: { ...state.prefs } });
      }
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        state.prefs = JSON.parse(body).CustomPrefs || {};
        state.prefPosts++;
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (p === '/Videos/item1/ms1/Subtitles/2/Stream.js') return json(200, events(zh));
    if (p === '/Videos/item1/ms1/Subtitles/3/Stream.js') return json(200, events(en));
    if (req.method === 'POST' && p === '/Sessions/sess1/Playing') {
      state.commands.push({ itemIds: url.searchParams.get('itemIds'), startPositionTicks: Number(url.searchParams.get('startPositionTicks')) });
      res.writeHead(204); return res.end();
    }
    json(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, state })));
}

module.exports = { start };

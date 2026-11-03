// End-to-end check: loads the unpacked extension into Chrome for Testing,
// points it at the mock Jellyfin, and drives the overlay and flashcards.
// Run: node test/e2e/run.js [--headful]   (screenshots go to $E2E_OUT or ./e2e-out)
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer');
const { start } = require('./mock-jellyfin');

const EXT = path.join(__dirname, '..', '..', 'src');
const OUT = process.env.E2E_OUT || path.join(process.cwd(), 'e2e-out');
const PORT = 8096;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

async function waitFor(fn, ms = 8000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const video = path.join(OUT, 'test.mp4');
  if (!fs.existsSync(video)) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', video]);
  }
  const { server, state } = await start(PORT, video);
  const FIREFOX = process.argv.includes('--firefox');
  const browser = FIREFOX
    ? await puppeteer.launch({
      browser: 'firefox',
      executablePath: process.env.FIREFOX || '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
      headless: !process.argv.includes('--headful'),
      extraPrefsFirefox: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 },
      defaultViewport: { width: 1280, height: 800 },
    })
    : await puppeteer.launch({
      headless: !process.argv.includes('--headful'),
      pipe: true,
      enableExtensions: [EXT],
      args: ['--autoplay-policy=no-user-gesture-required', '--window-size=1280,800', '--lang=en-US'],
      defaultViewport: { width: 1280, height: 800 },
    });
  console.log(`browser: ${await browser.version()}`);
  try {
    if (FIREFOX) await browser.installExtension(EXT);

    const page = await browser.newPage();
    page.on('console', (m) => { if (/zimu/i.test(m.text())) console.log('  [page]', m.text()); });
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    await page.goto(`${BASE}/web/index.html#/video`);

    const shown = await waitFor(() => page.evaluate(() => document.querySelectorAll('#zimu-root:not(.zimu-hidden) .zimu-w').length), 15000);
    check('overlay shows segmented words', !!shown, `${shown} words`);
    if (!shown) {
      console.log('  status:', await page.evaluate(() => { const r = document.querySelector('#zimu-root'); return r ? `${r.dataset.state} | ${r.className} | ${r.querySelector('.zimu-status').textContent} | t=${document.querySelector('video').currentTime}` : 'no root'; }));
      console.log('  requests:', state.log.filter((l) => !l.includes('/mock/')).slice(-12).join('\n    '));
    }

    await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 4; });
    await waitFor(() => page.evaluate(() => document.querySelector('.zimu-zh').textContent.includes('吃饭')));
    await sleep(300);
    const line = await page.evaluate(() => ({
      words: [...document.querySelectorAll('.zimu-w')].map((w) => [...w.querySelectorAll('ruby')].map((r) => r.firstChild.textContent).join('')),
      pinyin: [...document.querySelectorAll('.zimu-w rt')].map((r) => r.textContent).join(' '),
      en: document.querySelector('.zimu-en').textContent,
    }));
    check('words segmented', JSON.stringify(line.words) === JSON.stringify(['你', '今天', '想', '去', '哪儿', '吃饭']), JSON.stringify(line.words));
    check('pinyin with tone marks', line.pinyin === 'nǐ jīn tiān xiǎng qù nǎ r chī fàn', line.pinyin);
    check('english from English track', line.en === 'Where do you want to eat today?', line.en);
    await page.screenshot({ path: path.join(OUT, '1-line.png') });

    // click a word → definition popup
    const word = await page.$$('.zimu-w');
    await word[5].click();
    const pop = await waitFor(() => page.evaluate(() => document.querySelector('.zimu-popup') && document.querySelector('.zimu-popup').innerText));
    check('word popup with definition', !!pop && /eat/i.test(pop) && pop.includes('chīfàn'), (pop || '').split('\n').slice(0, 4).join(' | '));
    await page.screenshot({ path: path.join(OUT, '2-word-popup.png') });
    // clicking 吃饭 played its estimated moment (≈4.79–5.91 s in a 3.5–6.0 line)
    const heard = await waitFor(() => page.evaluate(() => { const v = document.querySelector('video'); return v.paused && v.currentTime > 4.5 ? v.currentTime : null; }), 4000, 50);
    check('clicking a word plays it and stops after it', heard != null && heard >= 5.8 && heard < 6.1, String(heard));
    await page.click('.zimu-save');
    const saved = await waitFor(() => page.evaluate(() => document.querySelector('.zimu-save').textContent.includes('Saved')), 8000);
    check('save to flashcards', !!saved);
    await page.keyboard.press('Escape');

    // drag from 想 to 吃饭 → phrase popup
    const words = await page.$$('.zimu-w');
    const a = await words[2].boundingBox();
    const b = await words[5].boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
    const phrase = await waitFor(() => page.evaluate(() => {
      const p = document.querySelector('.zimu-popup');
      const t = p && p.querySelector('.zimu-translation');
      return t && t.textContent !== 'Translating…' ? p.innerText : null;
    }), 10000);
    check('phrase popup', !!phrase && phrase.includes('想去哪儿吃饭'), (phrase || '').split('\n').slice(0, 4).join(' | '));
    await page.screenshot({ path: path.join(OUT, '3-phrase-popup.png') });
    await page.keyboard.press('Escape');
    await page.mouse.move(10, 10); // leave the subtitles so hover-pause lets go

    // hovering the subtitles no longer pauses
    await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 6.6; v.play(); });
    await page.hover('.zimu-lines');
    await sleep(500);
    check('hovering the subtitles keeps playing', await page.evaluate(() => !document.querySelector('video').paused));
    await page.mouse.move(10, 10);

    // speed: [ ] step 1%, { } step 5%, clamped to 60–100%
    await page.keyboard.press(']');
    await sleep(150);
    const r100 = await page.evaluate(() => document.querySelector('video').playbackRate);
    for (let i = 0; i < 5; i++) await page.keyboard.press('[');
    await sleep(300);
    const r95 = await page.evaluate(() => [document.querySelector('video').playbackRate, document.querySelector('.zimu-speed').textContent]);
    for (let i = 0; i < 12; i++) await page.keyboard.press('{');
    await sleep(300);
    const r60 = await page.evaluate(() => document.querySelector('video').playbackRate);
    check('speed control 60–100% in 1% steps', r100 === 1 && Math.abs(r95[0] - 0.95) < 1e-9 && r95[1] === '95%' && Math.abs(r60 - 0.6) < 1e-9, `${r100} ${r95.join(' ')} ${r60}`);
    await page.click('.zimu-speed');
    await sleep(200);

    // keyboard: A goes to the previous line
    await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 4.2; });
    await sleep(200);
    await page.keyboard.press('a');
    await sleep(400);
    const t = await page.evaluate(() => document.querySelector('video').currentTime);
    check('A jumps to previous line', t >= 0.3 && t < 1.5, t.toFixed(2));

    // the toolbar's 🗂 button opens the flashcard page
    await page.hover('.zimu-lines');
    await page.click('.zimu-toolbar button[title="Flashcards"]');
    const cardsTarget = await browser.waitForTarget((t) => t.url().includes('/cards/cards.html'), { timeout: 8000 });
    const cards = await cardsTarget.page();
    check('🗂 opens the flashcard page', !!cards, cardsTarget.url().split('/')[0]);
    await sleep(300);
    check('no "grant access" banner when sites are granted', await cards.evaluate(() => document.getElementById('perm-banner').hidden));
    await page.mouse.move(10, 10);

    // display modes: pinyin only
    await cards.evaluate(() => chrome.storage.local.set({ settings: { showHanzi: false, showPinyin: true, showEnglish: false } }));
    await sleep(400);
    const pyOnly = await page.evaluate(() => ({ text: document.querySelector('.zimu-zh').innerText, en: document.querySelector('.zimu-en').textContent, ruby: document.querySelectorAll('.zimu-zh ruby').length }));
    check('pinyin-only mode', pyOnly.ruby === 0 && /[āáǎàēéěèīíǐìōóǒòūúǔù]/.test(pyOnly.text) && !/\p{Script=Han}/u.test(pyOnly.text) && pyOnly.en === '', pyOnly.text);
    await page.bringToFront();
    await page.screenshot({ path: path.join(OUT, '4-pinyin-only.png') });
    await cards.evaluate(() => chrome.storage.local.set({ settings: {} }));

    // hovering the box (not a word) explains the sentence
    await cards.evaluate((base) => chrome.storage.local.set({ apiBaseUrl: base }), BASE);
    await page.bringToFront();
    await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 4.2; });
    await sleep(300);
    const explainText = () => page.evaluate(() => { const x = document.querySelector('.zimu-explain'); return x ? x.innerText : null; });
    await page.hover('.zimu-en');
    const noKey = await waitFor(async () => { const t = await explainText(); return t && /API key/.test(t) ? t : null; }, 4000);
    check('without a key, hovering explains how to add one', !!noKey);
    await page.mouse.move(10, 10);
    await waitFor(async () => (await explainText()) === null, 3000);

    await cards.bringToFront();
    await cards.click('#tab-settings');
    await cards.type('#api-key', 'sk-ant-test-key-1234');
    await cards.click('#api-key-save');
    await sleep(300);
    const keyStatus = await cards.evaluate(() => document.getElementById('api-key-status').textContent);
    check('API key saved from settings', keyStatus.includes('…1234'), keyStatus);

    await page.bringToFront();
    await page.hover('.zimu-en');
    const explained = await waitFor(async () => { const t = await explainText(); return t && t.includes('erhua') ? t : null; }, 8000);
    const call = state.claude[0];
    check('hovering the box streams a Claude explanation', !!explained && /Literal/.test(explained), (explained || '').split('\n').slice(0, 3).join(' | '));
    check('request: Opus 5.5, default fallbacks, line + subtitle + context', !!call && call.body.model === 'claude-opus-5-5' &&
      call.body.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(call.beta || '') && /^(Bearer )?sk-ant-test-key-1234$/.test(call.apiKey || '') &&
      call.body.messages[0].content.includes('你今天想去哪儿吃饭') && call.body.messages[0].content.includes('Where do you want to eat today?') &&
      call.body.messages[0].content.includes('我觉得他还没睡着'), call ? call.body.messages[0].content.split('\n').slice(0, 4).join(' / ') : 'no request');
    if (call && !/^(Bearer )?sk-ant-test-key-1234$/.test(call.apiKey || '')) console.log('  request:', JSON.stringify({ model: call.body.model, fallbacks: call.body.fallbacks, beta: call.beta, key: call.apiKey, headers: call.headers, effort: call.body.output_config }), '\n ', call.body.messages[0].content.replace(/\n/g, ' / '));
    await page.screenshot({ path: path.join(OUT, '6-explain.png') });
    await page.mouse.move(10, 10);
    await waitFor(async () => (await explainText()) === null, 3000);
    await page.hover('.zimu-en');
    const again = await waitFor(async () => { const t = await explainText(); return t && /saved explanation/.test(t) ? t : null; }, 4000);
    check('second hover uses the saved explanation (no new request)', !!again && state.claude.length === 1, `${state.claude.length} request(s)`);
    await page.mouse.move(10, 10);

    // flashcard page shows the card and plays its moment
    await cards.bringToFront();
    await cards.click('#tab-review');
    await cards.reload();
    const front = await waitFor(() => cards.evaluate(() => !document.getElementById('review-card').hidden && document.getElementById('r-hanzi').textContent));
    check('card due for review', front === '吃饭', front);
    await cards.keyboard.press('Space');
    const back = await cards.evaluate(() => ({ py: document.getElementById('r-pinyin').textContent, en: document.getElementById('r-english').textContent, src: document.getElementById('r-source').textContent, s: document.getElementById('r-sentence-en').textContent }));
    check('card back side', back.py === 'chīfàn' && /eat/.test(back.en) && back.src.includes('测试剧 S01E02') && back.s.includes('eat'), JSON.stringify(back));
    await cards.screenshot({ path: path.join(OUT, '5-card.png') });

    await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 15; });
    await cards.click('#r-play');
    const played = await waitFor(() => page.evaluate(() => { const v = document.querySelector('video'); return !v.paused && v.currentTime > 3 && v.currentTime < 4 ? v.currentTime : null; }), 5000, 50);
    check('▶ Play seeks the open Jellyfin tab to the line', !!played, String(played));
    const stopped = await waitFor(() => page.evaluate(() => { const v = document.querySelector('video'); return v.paused ? v.currentTime : null; }), 6000, 50);
    check('clip stops at the end of the line', stopped != null && stopped >= 5.9 && stopped < 6.6, String(stopped));

    // a clip link in a fresh tab (nothing playing yet) goes through the
    // server's remote-play command
    state.playing = false;
    await page.close();
    const link = await cards.evaluate(() => Zimu.clipUrl({ server: 'http://127.0.0.1:8096', itemId: 'item1', start: 6.5, end: 9.5 }));
    const fresh = await browser.newPage();
    await fresh.goto(link.replace('/web/#', '/web/index.html?noautoplay#'));
    const remote = await waitFor(() => fresh.evaluate(() => { const v = document.querySelector('video'); return !v.paused && v.currentTime > 6 ? v.currentTime : null; }), 15000, 50);
    check('clip link starts playback via remote-play', !!remote && state.log.some((l) => l.startsWith('POST /Sessions/sess1/Playing')), String(remote));
    const stopped2 = await waitFor(() => fresh.evaluate(() => { const v = document.querySelector('video'); return v.paused && v.currentTime > 6 ? v.currentTime : null; }), 8000, 50);
    check('…and stops at the end of that line', stopped2 != null && stopped2 >= 9.4 && stopped2 < 10.2, String(stopped2));
    const zhLine = await fresh.evaluate(() => document.querySelector('.zimu-zh').innerText.replace(/\s+/g, ''));
    check('ASS tags stripped', !zhLine.includes('an8'), zhLine.slice(0, 40));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  console.log(`screenshots: ${OUT}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

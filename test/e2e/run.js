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
    await page.mouse.move(10, 10);

    // display modes: pinyin only
    await cards.evaluate(() => chrome.storage.local.set({ settings: { showHanzi: false, showPinyin: true, showEnglish: false } }));
    await sleep(400);
    const pyOnly = await page.evaluate(() => ({ text: document.querySelector('.zimu-zh').innerText, en: document.querySelector('.zimu-en').textContent, ruby: document.querySelectorAll('.zimu-zh ruby').length }));
    check('pinyin-only mode', pyOnly.ruby === 0 && /[āáǎàēéěèīíǐìōóǒòūúǔù]/.test(pyOnly.text) && !/\p{Script=Han}/u.test(pyOnly.text) && pyOnly.en === '', pyOnly.text);
    await page.bringToFront();
    await page.screenshot({ path: path.join(OUT, '4-pinyin-only.png') });
    await cards.evaluate(() => chrome.storage.local.set({ settings: {} }));

    // flashcard page shows the card and plays its moment
    await cards.bringToFront();
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

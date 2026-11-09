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
  // E2E_VIDEO=scene swaps the SMPTE test pattern for a slow dark gradient,
  // so the screenshots look like a player (npm run screenshots)
  const scene = process.env.E2E_VIDEO === 'scene';
  const video = path.join(OUT, scene ? 'scene.mp4' : 'test.mp4');
  if (!fs.existsSync(video)) {
    const source = scene
      ? 'gradients=size=1280x720:rate=25:c0=0x0b1a2b:c1=0x24344d:c2=0x3b2a4a:c3=0x0f3b45:nb_colors=4:speed=0.01'
      : 'testsrc2=size=1280x720:rate=25';
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', source, '-f', 'lavfi', '-i', 'sine=frequency=440',
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

    // change Zimu settings from a short-lived extension page
    async function cardsSet(patch) {
      const sw = await browser.waitForTarget((t) => /^(chrome|moz)-extension:/.test(t.url()), { timeout: 8000 });
      const tmp = await browser.newPage();
      await tmp.goto(`${sw.url().split('/').slice(0, 3).join('/')}/cards/cards.html#settings`);
      await tmp.evaluate((p) => Zimu.Settings.set(p), patch);
      await tmp.close();
      await page.bringToFront();
      await sleep(300);
    }
    const page = await browser.newPage();
    page.on('console', (m) => { if (/zimu/i.test(m.text())) console.log('  [page]', m.text()); });
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    await page.evaluateOnNewDocument(() => {
      window.__pauses = [];
      document.addEventListener('pause', (e) => {
        window.__pauses.push([e.target.currentTime.toFixed(2), new Error().stack.split('\n').slice(2, 4).join(' / ')]);
      }, true);
    });
    // a frozen overlay left by an older copy of the extension (Zen keeps it
    // in open tabs across an update) is cleared when Zimu starts
    await page.evaluateOnNewDocument(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const stale = document.createElement('div');
        stale.id = 'zimu-root';
        stale.className = 'zimu-stale';
        stale.textContent = '旧字幕';
        document.body.append(stale);
      });
    });
    await page.goto(`${BASE}/web/index.html#/video`);

    const shown = await waitFor(() => page.evaluate(() => document.querySelectorAll('#zimu-root:not(.zimu-hidden) .zimu-w').length), 15000);
    check('overlay shows segmented words', !!shown, `${shown} words`);
    if (!shown) {
      console.log('  status:', await page.evaluate(() => { const r = document.querySelector('#zimu-root'); return r ? `${r.dataset.state} | ${r.className} | t=${document.querySelector('video').currentTime}` : 'no root'; }));
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
    // clicking 吃饭 jumped to its estimated moment (≈4.79 s in a 3.5–6.0 line)
    // and, with auto-pause off, kept playing past the line
    const heard = await waitFor(() => page.evaluate(() => { const v = document.querySelector('video'); return !v.paused && v.currentTime > 4.6 && v.currentTime < 5.2 ? v.currentTime : null; }), 3000, 30);
    const carried = await waitFor(() => page.evaluate(() => { const v = document.querySelector('video'); return !v.paused && v.currentTime > 6.2 ? v.currentTime : null; }), 3000, 50);
    check('clicking a word plays from it and (auto-pause off) keeps going', heard != null && carried != null, `${heard} → ${carried}`);
    if (carried == null) console.log('  pauses:', await page.evaluate(() => JSON.stringify(window.__pauses || [])));
    // ▶ Hear it plays just the word
    await page.evaluate(() => [...document.querySelectorAll('.zimu-popup .zimu-btn')].find((b) => b.textContent.includes('Hear it')).click());
    const wordOnly = await waitFor(() => page.evaluate(() => { const v = document.querySelector('video'); return v.paused && v.currentTime > 4.6 ? v.currentTime : null; }), 4000, 50);
    check('▶ Hear it plays just the word and stops', wordOnly != null && wordOnly >= 5.8 && wordOnly < 6.1, String(wordOnly));
    // the Zimu button while playing: stop at the end of this line
    await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 4.2; v.play(); });
    await sleep(200);
    await page.click('.zimu-osd-stop');
    const lineEnd = await waitFor(() => page.evaluate(() => { const v = document.querySelector('video'); return v.paused && v.currentTime > 4.5 ? v.currentTime : null; }), 4000, 50);
    check('the Zimu button while playing plays the line again and stops at its end', lineEnd != null && lineEnd >= 5.85 && lineEnd < 6.05, String(lineEnd));
    // …and while paused: the line again from its start, stopping at its end
    await page.click('.zimu-osd-stop');
    const fromStart = await waitFor(() => page.evaluate(() => { const v = document.querySelector('video'); return !v.paused && v.currentTime < 4.0 ? v.currentTime : null; }), 2000, 20);
    const lineEnd2 = await waitFor(() => page.evaluate(() => { const v = document.querySelector('video'); return v.paused && v.currentTime > 4.5 ? v.currentTime : null; }), 5000, 50);
    check('…while paused it plays the line again from its start and stops at its end', fromStart != null && fromStart >= 3.2 && lineEnd2 != null && lineEnd2 >= 5.85 && lineEnd2 < 6.05, `${fromStart} → ${lineEnd2}`);
    // with nothing on screen (before the first line) it plays the next line; Jellyfin's play carries on instead
    await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 0.1; v.play(); });
    await sleep(150);
    await page.keyboard.press('z');
    const nextEnd = await waitFor(() => page.evaluate(() => { const v = document.querySelector('video'); return v.paused && v.currentTime > 2.5 ? v.currentTime : null; }), 5000, 50);
    await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 4.2; v.play(); });
    await page.keyboard.press('z');
    await sleep(100);
    await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.play(); }); // Jellyfin's play button
    const carriedOn = await waitFor(() => page.evaluate(() => { const v = document.querySelector('video'); return !v.paused && v.currentTime > 6.2 ? v.currentTime : null; }), 4000, 50);
    check('Z with no line on screen plays the next line and stops at its end; Jellyfin’s play then carries on past it', nextEnd != null && nextEnd >= 2.85 && nextEnd < 3.05 && carriedOn != null, `${nextEnd} ${carriedOn}`);
    await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 4.2; });
    await sleep(200);
    await (await page.$$('.zimu-w'))[5].click();
    await waitFor(() => page.evaluate(() => !!document.querySelector('.zimu-popup')), 2000);
    await page.evaluate(() => document.querySelector('video').pause());
    await page.click('.zimu-save');
    const saved = await waitFor(() => page.evaluate(() => document.querySelector('.zimu-save').textContent.includes('Saved')), 8000);
    check('save to flashcards', !!saved);
    const mark = await waitFor(() => page.evaluate(() => {
      const m = document.querySelector('.osdControls .sliderContainer .zimu-mark');
      if (!m) return null;
      const v = document.querySelector('video');
      return { left: parseFloat(m.style.left), want: (3.5 / v.duration) * 100, n: document.querySelectorAll('.zimu-mark').length, title: m.title, green: getComputedStyle(m).backgroundColor };
    }), 3000);
    check('a green tick on Jellyfin’s seek bar where the card was made', !!mark && Math.abs(mark.left - mark.want) < 0.5 && mark.n === 1 && /吃饭/.test(mark.title) && mark.green === 'rgb(95, 208, 104)', JSON.stringify(mark));
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

    // layout: Zimu's controls are a row of their own under Jellyfin's,
    // lined up with them on the left
    const layout = await page.evaluate(() => {
      const lines = document.querySelector('.zimu-lines').getBoundingClientRect();
      const osd = document.querySelector('.zimu-osd');
      return {
        toolbar: !!document.querySelector('.zimu-toolbar'),
        labels: [...osd.querySelectorAll('.zimu-osd-btn')].map((b) => b.title.split(' (')[0]),
        inBar: !!osd && osd.parentElement.matches('.osdControls') && osd.previousElementSibling.matches('.buttons') &&
          !osd.closest('.hide') && osd.getBoundingClientRect().width > 0,
        below: osd.getBoundingClientRect().top >= osd.previousElementSibling.getBoundingClientRect().bottom,
        leftGap: osd.firstElementChild.getBoundingClientRect().left - osd.previousElementSibling.firstElementChild.getBoundingClientRect().left,
        rightGap: document.querySelector('.zimu-osd-tune').getBoundingClientRect().right - osd.previousElementSibling.lastElementChild.getBoundingClientRect().right,
        centreGap: (() => {
          const row = osd.getBoundingClientRect();
          const first = osd.querySelector('[title^="Previous line"]').getBoundingClientRect();
          const last = osd.querySelector('[title^="Faster"]').getBoundingClientRect();
          return (first.left + last.right) / 2 - (row.left + row.right) / 2;
        })(),
        order: [...osd.querySelectorAll('button, .zimu-speed-box')].map((el) => (el.title || el.textContent || el.className).split(' (')[0].split(' —')[0].split(',')[0]),
        linesBottom: lines.bottom,
      };
    });
    check('no floating control bar: previous, next and auto-pause are with Zimu’s controls', !layout.toolbar &&
      ['Previous line', 'Next line'].every((l) => layout.labels.includes(l)) && layout.labels.some((l) => /^Play(ing)? this line again/.test(l)), JSON.stringify(layout));
    check('Zimu’s controls are under the visible Jellyfin controls (not a cached hidden page), aligned left with them',
      layout.inBar && layout.below && Math.abs(layout.leftGap) <= 1, JSON.stringify(layout));
    check('the row runs the Zimu switch, line controls, speed, then flashcards and settings under fullscreen',
      /^Zimu.*,Previous line,Play(ing)? this line again[^,]*,Next line,Slower by 1%,.*,Faster by 1%,(Show Claude’s explanation of this line,)?Zimu flashcards,Zimu subtitle settings$/.test(layout.order.join(',')) &&
      Math.abs(layout.rightGap) <= 1, JSON.stringify({ order: layout.order, rightGap: layout.rightGap }));
    check('the line and speed controls are centred in the bar', Math.abs(layout.centreGap) <= 1, `off by ${layout.centreGap}px`);

    // the subtitles have one fixed height, just above Jellyfin's controls
    // (its bar's box starts well above them, for the gradient)
    const setBar = (shown) => page.evaluate((on) => {
      [...document.querySelectorAll('.videoOsdBottom')].pop().classList.toggle('videoOsdBottom-hidden', !on);
    }, shown);
    await setBar(true);
    await sleep(900);
    const fixed = await page.evaluate(() => {
      const lines = document.querySelector('.zimu-lines').getBoundingClientRect();
      return {
        linesBottom: lines.bottom,
        gap: [...document.querySelectorAll('.osdControls')].pop().getBoundingClientRect().top - lines.bottom,
        limit: window.innerHeight * 0.03,
      };
    });
    await page.screenshot({ path: path.join(OUT, '7-controls.png') });
    check('subtitles stay at the same height when Jellyfin’s bar shows', fixed.linesBottom === layout.linesBottom, `${layout.linesBottom} → ${fixed.linesBottom}`);
    check('subtitles sit just above Jellyfin’s controls, never on them', fixed.gap >= 0 && fixed.gap <= fixed.limit, JSON.stringify(fixed));

    const clickBar = (title) => page.click(`.zimu-osd-btn[title^="${title}"]`);
    await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 1; });
    await clickBar('Next line');
    const nexted = await waitFor(() => page.evaluate(() => { const t = document.querySelector('video').currentTime; return t >= 3.2 && t < 5 ? t : null; }), 3000);
    await clickBar('Previous line');
    const preved = await waitFor(() => page.evaluate(() => { const t = document.querySelector('video').currentTime; return t >= 0.3 && t < 3 ? t : null; }), 3000);
    check('previous and next line buttons in the bar move between lines', !!nexted && !!preved, `${nexted} ${preved}`);
    await page.evaluate(() => document.querySelector('video').pause());
    await sleep(100);
    const stopState = () => page.$eval('.zimu-osd-stop', (b) => {
      const mark = b.querySelector('.zimu-cassette .zimu-pause-mark');
      const s = mark && getComputedStyle(mark);
      return { on: b.classList.contains('zimu-on'), mark: !!mark && s.display !== 'none', blink: !!mark && s.animationName === 'zimu-blink', title: b.title };
    });
    const stopIdle = await stopState();
    await page.click('.zimu-osd-stop'); // paused: plays the line again, stop pending
    await sleep(200);
    const stopArmed = await stopState();
    await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.play(); }); // Jellyfin's play
    await sleep(200);
    const stopCleared = await stopState();
    check('the Zimu button shows a pending stop: plain cassette, then a blinking pause sign, plain again after Jellyfin’s play',
      !stopIdle.on && !stopIdle.mark && stopArmed.on && stopArmed.mark && stopArmed.blink && !stopCleared.on && !stopCleared.mark, JSON.stringify({ stopIdle, stopArmed, stopCleared }));
    const switchTitle = await page.$eval('.zimu-osd-toggle', (b) => b.title);
    check('tooltips name the keys: Z on the Zimu button, Shift+Z on the switch',
      /\(Z\)$/.test(stopIdle.title) && /play this line again/i.test(stopIdle.title) && /\(Z\)$/.test(stopCleared.title) && /Shift\+Z/.test(switchTitle), `"${stopIdle.title}" / "${stopCleared.title}" / "${switchTitle}"`);

    // with the bar tucked away, a key still says what it did
    await setBar(false);
    await sleep(900);
    await page.keyboard.press('z');
    const keyFlash = await waitFor(() => page.evaluate(() => (document.querySelector('.zimu-flash') || {}).textContent), 1000);
    await page.evaluate(() => document.querySelector('video').pause()); // the speed tests below want it still
    check('a key press flashes its result while Jellyfin’s bar is hidden', /Playing the line again/.test(keyFlash || ''), String(keyFlash));
    await page.mouse.move(10, 10);

    const rate = () => page.evaluate(() => document.querySelector('video').playbackRate);
    const speedValue = () => page.evaluate(() => document.querySelector('.zimu-speed-slider').value);
    const setSlider = async (n) => {
      await page.$eval('.zimu-speed-slider', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, n);
      await sleep(150);
    };

    // keys: [ ] step 1%, { } step 5%, clamped to 40–100%
    for (let i = 0; i < 5; i++) await page.keyboard.press('[');
    await sleep(300);
    const r95 = [await rate(), await speedValue()];
    for (let i = 0; i < 13; i++) await page.keyboard.press('{');
    await sleep(300);
    const r40 = await rate();
    for (let i = 0; i < 15; i++) await page.keyboard.press('}');
    await sleep(300);
    const r100 = await rate();
    await page.keyboard.press(']');
    await sleep(150);
    check('speed keys: 40–100% in 1% steps, capped at 100', Math.abs(r95[0] - 0.95) < 1e-9 && r95[1] === '95' && Math.abs(r40 - 0.4) < 1e-9 && Math.abs(r100 - 1) < 1e-9 && Number(await speedValue()) === 100,
      `${r95.join(' ')} ${r40} ${r100}`);
    await setSlider(100);

    // a slider between − and +, not a number box
    const speedUi = await page.evaluate(() => {
      const box = (sel) => document.querySelector(sel).getBoundingClientRect();
      const el = document.querySelector('.zimu-speed-slider');
      return {
        input: !!document.querySelector('.zimu-speed-input'),
        type: el.type, min: el.min, max: el.max,
        between: box('.zimu-osd button[title^="Slower"]').right <= box('.zimu-speed-slider').left &&
          box('.zimu-speed-slider').right <= box('.zimu-osd button[title^="Faster"]').left,
        readout: document.querySelector('.zimu-speed-box').textContent,
        widthEm: el.getBoundingClientRect().width / parseFloat(getComputedStyle(el).fontSize),
        colours: [...new Set(['.zimu-osd-toggle', '.zimu-osd-btn', '.zimu-speed-box'].map((s) => getComputedStyle(document.querySelector(s)).color))],
      };
    });
    check('speed is a 40–100% slider between − and +, showing its value', !speedUi.input && speedUi.type === 'range' && speedUi.min === '40' && speedUi.max === '100' &&
      speedUi.between && speedUi.readout === '100%', JSON.stringify(speedUi));
    check('the speed slider is 7.5em long', Math.abs(speedUi.widthEm - 7.5) < 0.01, String(speedUi.widthEm));
    check('Zimu’s bar controls are the second-tone green', speedUi.colours.length === 1 && speedUi.colours[0] === 'rgb(95, 208, 104)', speedUi.colours.join(' '));

    // dragging it sets the speed and hands the keyboard back
    const track = await (await page.$('.zimu-speed-slider')).boundingBox();
    const y = track.y + track.height / 2;
    await page.mouse.move(track.x + track.width * 0.8, y);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width * 0.2, y, { steps: 6 });
    const midDrag = [await rate(), await speedValue()];
    await page.mouse.up();
    await sleep(150);
    const dragged = await page.evaluate(() => document.activeElement.tagName);
    const dragSpeed = Number(await speedValue());
    await page.keyboard.press(']');
    await sleep(150);
    check('dragging the slider changes speed live, then keys work again', dragSpeed < 60 && Math.abs(midDrag[0] - Number(midDrag[1]) / 100) < 1e-9 && dragged !== 'INPUT' &&
      Number(await speedValue()) === dragSpeed + 1, `${midDrag} ${dragged} ${dragSpeed} → ${await speedValue()}`);

    // while it has the keyboard, keys stay with it and never reach Jellyfin
    await setSlider(100);
    await page.focus('.zimu-speed-slider');
    const tBefore = await page.evaluate(() => document.querySelector('video').currentTime);
    await page.keyboard.press('5');
    await page.keyboard.press('ArrowLeft');
    await sleep(150);
    const tAfter = await page.evaluate(() => document.querySelector('video').currentTime);
    const arrowed = await speedValue();
    await page.keyboard.press('Escape');
    const escaped = await page.evaluate(() => document.activeElement.tagName);
    check('with the slider focused, arrows step it, keys don’t reach Jellyfin (no seek), Esc leaves it',
      Math.abs(tAfter - tBefore) < 0.05 && arrowed === '99' && escaped !== 'INPUT', `${tBefore.toFixed(2)} → ${tAfter.toFixed(2)} ${arrowed} ${escaped}`);

    // − / +: a click steps 1%, holding repeats faster and faster
    await setSlider(100);
    await page.click('.zimu-osd button[title^="Slower"]');
    await sleep(150);
    const oneClick = await speedValue();
    const minus = await (await page.$('.zimu-osd button[title^="Slower"]')).boundingBox();
    await page.mouse.move(minus.x + minus.width / 2, minus.y + minus.height / 2);
    await page.mouse.down();
    await sleep(700);
    const after700 = Number(await speedValue());
    await sleep(800);
    await page.mouse.up();
    const after1500 = Number(await speedValue());
    await sleep(400);
    const settled = Number(await speedValue());
    check('click − steps 1%; holding it accelerates', oneClick === '99' && after700 >= 94 && after700 <= 97 &&
      99 - after1500 >= 12 && settled === after1500, `click→${oneClick}, held 0.7 s→${after700}, 1.5 s→${after1500}, released→${settled}`);
    await page.mouse.move(10, 10);
    await setSlider(100);

    // ⚙ in Jellyfin's bar opens the settings panel just above it
    await page.click('.zimu-osd button[title="Zimu subtitle settings"]');
    await sleep(200);
    const panelPos = await page.evaluate(() => {
      const p = document.querySelector('.zimu-panel');
      const b = document.querySelector('.zimu-osd button[title="Zimu subtitle settings"]');
      return p && { above: p.getBoundingClientRect().bottom <= b.getBoundingClientRect().top, right: Math.round(p.getBoundingClientRect().right - b.getBoundingClientRect().right) };
    });
    check('⚙ opens settings above the button', !!panelPos && panelPos.above && Math.abs(panelPos.right) <= 2, JSON.stringify(panelPos));
    // text and background opacity sliders (defaults 100% / 75%)
    const look = () => page.evaluate(() => ({ text: getComputedStyle(document.querySelector('.zimu-zh')).opacity, bg: getComputedStyle(document.querySelector('.zimu-lines')).backgroundColor }));
    // inside a line: a finished line is dimmed, which would hide the slider's value
    await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 1.5; });
    await sleep(300);
    const lookBefore = await look();
    await page.evaluate(() => {
      const set = (label, v) => {
        const input = [...document.querySelectorAll('.zimu-panel .zimu-range')].find((l) => l.textContent.startsWith(label)).querySelector('input');
        input.value = v;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('Text', 60);
      set('Background', 90);
    });
    await sleep(200);
    const lookAfter = await look();
    await sleep(600); // let it save
    const sliderLabels = await page.evaluate(() => [...document.querySelectorAll(".zimu-panel .zimu-range span")].map((x) => x.textContent).join(', '));
    check('opacity sliders: text and background', lookBefore.text === '1' && lookBefore.bg === 'rgba(0, 0, 0, 0.75)' &&
      lookAfter.text === '0.6' && lookAfter.bg === 'rgba(0, 0, 0, 0.9)', `${JSON.stringify(lookBefore)} → ${JSON.stringify(lookAfter)} [${sliderLabels}]`);
    await cardsSet({ textOpacity: 100, bgOpacity: 75 });
    await page.keyboard.press('Escape');
    await page.mouse.click(10, 10);

    // a finished line lingers (dimmed) briefly, not through a long silence:
    // the last line ends at 13.0 s and nothing follows
    const zhAt = async (t) => {
      await page.evaluate((x) => { const v = document.querySelector('video'); v.pause(); v.currentTime = x; }, t);
      await sleep(300);
      return page.evaluate(() => document.querySelector('.zimu-zh').textContent.replace(/[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü\s]/g, ''));
    };
    const lingering = await zhAt(14.0);
    const cleared = await zhAt(16.5);
    check('a finished line stays ~3 s, then clears during silence', lingering.includes('这个问题') && cleared === '', `14.0 s: "${lingering}" · 16.5 s: "${cleared}"`);

    // keyboard: A goes to the previous line
    await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 4.2; });
    await sleep(200);
    await page.keyboard.press('a');
    await sleep(400);
    const t = await page.evaluate(() => document.querySelector('video').currentTime);
    check('A jumps to previous line', t >= 0.3 && t < 1.5, t.toFixed(2));
    check('a frozen overlay from an older Zimu is cleared', await page.evaluate(() => !document.querySelector('.zimu-stale') && document.querySelectorAll('#zimu-root').length === 1));

    // Shift+Z switches Zimu off for this show: no overlay, no pending stop, no
    // speed, Jellyfin's own subtitles back; it stays off after a reload
    const shiftZ = async () => { await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); };
    await page.keyboard.press('z'); // a stop pending, to prove switching off drops it
    await sleep(300);
    await shiftZ();
    await sleep(300);
    const offState = () => page.evaluate(() => {
      const vis = (sel) => { const el = document.querySelector(sel); return !!el && el.getClientRects().length > 0; };
      return {
        lines: vis('#zimu-root .zimu-lines'),
        nativeHidden: document.documentElement.classList.contains('zimu-hide-native'),
        speedBox: vis('.zimu-osd .zimu-speed-box'),
        tune: vis('.zimu-osd .zimu-osd-tune'),
        tuneRight: Math.round(document.querySelector('.zimu-osd-tune').getBoundingClientRect().right - document.querySelector('.btnFullscreen').getBoundingClientRect().right),
        rate: document.querySelector('video').playbackRate,
      };
    });
    const off1 = await offState();
    const flashText = await page.evaluate(() => (document.querySelector('.zimu-flash') || {}).textContent || '');
    await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 5.0; v.play(); });
    await sleep(1600);
    const playedThrough = await page.evaluate(() => { const v = document.querySelector('video'); return [!v.paused, v.currentTime]; });
    check('Shift+Z turns Zimu off: overlay and speed gone, tune stays, Jellyfin subs back, 100% speed',
      !off1.lines && !off1.nativeHidden && !off1.speedBox && off1.tune && Math.abs(off1.tuneRight) <= 1 && off1.rate === 1 && /off for this show/.test(flashText),
      `${JSON.stringify(off1)} "${flashText}"`);
    check('…and the pending stop is dropped', playedThrough[0] && playedThrough[1] > 6.2, playedThrough.join(' '));
    await page.reload();
    await waitFor(() => page.evaluate(() => /item=item1 zh=[1-9]/.test((document.getElementById('zimu-root') || { dataset: {} }).dataset.state || '')));
    await sleep(300);
    const off2 = await offState();
    check('off is remembered for the show after a reload', !off2.lines && !off2.nativeHidden, JSON.stringify(off2));
    await page.click('.zimu-osd .zimu-osd-tune');
    const zhChoice = await page.evaluate(() => { const s = document.querySelector('.zimu-panel select'); return s && s.value; });
    check('the Chinese track menu shows Off for this show', zhChoice === 'off', String(zhChoice));
    await page.evaluate(() => {
      const s = document.querySelector('.zimu-panel select');
      const opt = [...s.options].find((o) => o.value !== 'off');
      s.value = opt.value;
      s.dispatchEvent(new Event('change'));
    });
    await page.keyboard.press('Escape');
    await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 4.2; });
    await sleep(400);
    const on = await offState();
    const onText = await page.evaluate(() => document.querySelector('.zimu-zh').textContent);
    check('picking a track turns it back on', on.lines && on.nativeHidden && on.speedBox && /吃.*饭/.test(onText), `${JSON.stringify(on)} "${onText.slice(0, 20)}"`);
    await shiftZ();
    await sleep(200);
    await shiftZ();
    await sleep(200);
    check('Shift+Z toggles it off and on again', (await offState()).lines);
    // the Zimu switch in Jellyfin's bar does the same
    const sw = () => page.evaluate(() => {
      const b = document.querySelector('.zimu-osd .zimu-osd-toggle');
      return b && { text: b.textContent, checked: b.getAttribute('aria-checked'), visible: getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0 };
    });
    const swOn = await sw();
    await page.click('.zimu-osd .zimu-osd-toggle');
    await sleep(300);
    const swOff = await sw();
    const linesAfterSwitch = (await offState()).lines;
    await page.screenshot({ path: path.join(OUT, '3b-zimu-switch-off.png') });
    await page.click('.zimu-osd .zimu-osd-toggle');
    await sleep(300);
    check('a “Zimu” switch in Jellyfin’s bar turns it off and on', swOn && swOn.text === 'Zimu' && swOn.checked === 'true' &&
      swOff && swOff.visible && swOff.checked === 'false' && !linesAfterSwitch && (await offState()).lines, `${JSON.stringify(swOn)} → ${JSON.stringify(swOff)}`);
    await page.keyboard.press('q'); // auto-pause back off
    await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 0.7; }); // where A left it
    await sleep(300);

    // the 🗂 button in Jellyfin's bar opens the flashcard page
    await page.click('.zimu-osd button[title="Zimu flashcards"]');
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
    await cards.evaluate(() => chrome.storage.local.set({ settings: { toneColors: true } }));
    await sleep(400);
    // 我觉得他还没睡着: wǒ(3) jué(2) de(5) tā(1) hái(2) méi(2) shuì(4) zháo(2)
    const tones = await page.evaluate(() => Object.fromEntries([1, 2, 3, 4, 5].map((n) => {
      const el = document.querySelector(`.zimu-zh .zimu-t${n}`);
      return [n, el ? getComputedStyle(el).color : null];
    })));
    check('tone colours: 1 blue, 2 green, 3 orange, 4 red, neutral grey', tones[1] === 'rgb(90, 169, 255)' && tones[2] === 'rgb(95, 208, 104)' && tones[3] === 'rgb(255, 154, 46)' &&
      tones[4] === 'rgb(255, 92, 92)' && tones[5] === 'rgb(200, 200, 200)', JSON.stringify(tones));
    // display mode: meanings under each word (hanzi + pinyin + gloss columns)
    await cards.evaluate(() => chrome.storage.local.set({ settings: { showGloss: true } }));
    await sleep(400);
    const gloss = await page.evaluate(() => {
      const words = [...document.querySelectorAll('.zimu-zh .zimu-w')];
      const g = words.map((w) => w.querySelector('.zimu-g'));
      const rt = document.querySelector('.zimu-zh rt');
      const g0 = g.find((x) => x && x.textContent);
      const same = g0 && rt && getComputedStyle(g0).fontSize === getComputedStyle(rt).fontSize && getComputedStyle(g0).color === getComputedStyle(rt).color;
      return { words: words.length, glossed: g.filter((x) => x && x.textContent).length, sample: g0 ? g0.textContent : '', same };
    });
    check('meanings: every word has a gloss row, most are filled, pinyin-sized', gloss.words > 0 && gloss.glossed >= gloss.words / 2 && gloss.same, JSON.stringify(gloss));
    await page.screenshot({ path: path.join(OUT, '4b-meanings.png') });
    await cards.evaluate(() => chrome.storage.local.set({ settings: {} }));

    // clicking the box (not a word) explains the sentence; hovering doesn't
    await cards.evaluate((base) => chrome.storage.local.set({ apiBaseUrl: base }), BASE);
    await page.bringToFront();
    const video = (fn) => page.evaluate(fn);
    await video(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 4.2; });
    await sleep(300);
    const explainText = () => page.evaluate(() => { const x = document.querySelector('.zimu-explain'); return x ? x.innerText : null; });
    await page.hover('.zimu-en');
    await sleep(1000);
    check('hovering the box doesn’t open an explanation', (await explainText()) === null);
    await page.click('.zimu-en');
    const noKey = await waitFor(async () => { const t = await explainText(); return t && /API key/.test(t) ? t : null; }, 4000);
    check('without a key, hovering explains how to add one', !!noKey);
    await page.keyboard.press('Escape');
    check('Esc dismisses the explanation', await waitFor(async () => (await explainText()) === null, 2000));

    await cards.bringToFront();
    await cards.click('#tab-settings');
    await cards.type('#api-key', 'sk-ant-test-key-1234');
    await cards.click('#api-key-save');
    await sleep(300);
    const keyStatus = await cards.evaluate(() => document.getElementById('api-key-status').textContent);
    check('API key saved from settings', keyStatus.includes('…1234'), keyStatus);

    // opening one pauses playback
    await page.bringToFront();
    await page.mouse.move(10, 10);
    await video(() => { const v = document.querySelector('video'); v.currentTime = 4.0; v.play(); });
    await sleep(200);
    await page.click('.zimu-en');
    const explained = await waitFor(async () => { const t = await explainText(); return t && t.includes('erhua') ? t : null; }, 8000);
    const call = state.claude[0];
    check('clicking the box streams a Claude explanation', !!explained && /Literal/.test(explained), (explained || '').split('\n').slice(0, 3).join(' | '));
    check('opening an explanation pauses the video', await video(() => document.querySelector('video').paused));
    check('request: Opus 5.5, default fallbacks, line + subtitle + context', !!call && call.body.model === 'claude-opus-5-5' &&
      call.body.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(call.beta || '') && /^(Bearer )?sk-ant-test-key-1234$/.test(call.apiKey || '') &&
      call.body.messages[0].content.includes('你今天想去哪儿吃饭') && call.body.messages[0].content.includes('Where do you want to eat today?') &&
      call.body.messages[0].content.includes('我觉得他还没睡着'), call ? call.body.messages[0].content.split('\n').slice(0, 4).join(' / ') : 'no request');
    await page.screenshot({ path: path.join(OUT, '6-explain.png') });

    // it stays: mouse away, a word popup, playing within the line
    await page.mouse.move(10, 10);
    await sleep(1200);
    const stays = !!(await explainText());
    const words2 = await page.$$('.zimu-w');
    await words2[words2.length - 1].click(); // 吃饭: popup + plays the word
    await sleep(300);
    const both = await page.evaluate(() => !!document.querySelector('.zimu-popup') && !!document.querySelector('.zimu-explain'));
    await page.keyboard.press('Escape'); // closes the popup only
    await sleep(200);
    const afterEsc = await page.evaluate(() => !document.querySelector('.zimu-popup') && !!document.querySelector('.zimu-explain'));
    await video(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 4.3; });
    await sleep(200);
    check('explanation stays when the mouse leaves, a word is clicked, or Esc closes the popup', stays && both && afterEsc, `${stays} ${both} ${afterEsc}`);

    // scrolling inside it doesn't reach Jellyfin (which turns the volume)
    await page.evaluate(() => { window.__wheel = false; document.addEventListener('wheel', () => { window.__wheel = true; }); });
    const xBox = await (await page.$('.zimu-explain')).boundingBox();
    await page.mouse.move(xBox.x + xBox.width / 2, xBox.y + xBox.height / 2);
    await page.mouse.wheel({ deltaY: 120 });
    await sleep(150);
    const wheelInPanel = await page.evaluate(() => window.__wheel);
    await page.mouse.move(200, 200);
    await page.mouse.wheel({ deltaY: 120 });
    await sleep(150);
    const wheelOnVideo = await page.evaluate(() => window.__wheel);
    check('scrolling the explanation doesn’t reach Jellyfin’s volume', wheelInPanel === false && wheelOnVideo === true, `panel:${wheelInPanel} video:${wheelOnVideo}`);
    await page.mouse.move(10, 10);

    // moving on hides it; coming back shows the saved one (no new request)
    await video(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 6.8; });
    const gone = await waitFor(async () => (await explainText()) === null, 2000);
    await video(() => { document.querySelector('video').currentTime = 4.3; });
    const cameBack = await waitFor(async () => { const t = await explainText(); return t && t.includes('erhua') && /Saved to Sentences/.test(t) ? t : null; }, 4000);
    check('next line hides it; going back brings it back from the save', !!gone && !!cameBack && state.claude.length === 1, `gone:${!!gone} back:${!!cameBack} requests:${state.claude.length}`);
    check('…without pausing again', await video(() => document.querySelector('video').paused), 'paused by the seek, not re-paused');

    // Hide tucks it away and leaves a Show button; going away and back brings
    // the button, not the panel; the button reopens it (from the save, no new request)
    // the speech bubble in Zimu's bar, left of the flashcards, only while an explanation is hidden
    const showBtn = () => page.evaluate(() => {
      const b = document.querySelector('.zimu-osd .zimu-osd-end .zimu-osd-show');
      if (!b || getComputedStyle(b).display === 'none') return null;
      return b.nextElementSibling && /flashcards/.test(b.nextElementSibling.title) ? 'Show explanation' : 'misplaced';
    });
    await page.click('.zimu-explain .zimu-x-hide');
    await sleep(200);
    const hiddenNow = { panel: await explainText(), show: await showBtn() };
    await setBar(true);
    await page.screenshot({ path: path.join(OUT, '6b-explain-hidden.png') });
    await video(() => { document.querySelector('video').currentTime = 6.8; });
    await sleep(400);
    const awayShow = await showBtn();
    await video(() => { document.querySelector('video').currentTime = 4.3; });
    await sleep(1200);
    const stayedAway = (await explainText()) === null;
    const backShow = await showBtn();
    await page.click('.zimu-osd .zimu-osd-show');
    const reopened = await waitFor(async () => { const t = await explainText(); return t && /Saved to Sentences/.test(t) ? t : null; }, 4000);
    const showAfter = await showBtn();
    check('Hide leaves a Show explanation button for the line on screen (not for another line); returning shows the button, not the panel',
      hiddenNow.panel === null && hiddenNow.show === 'Show explanation' && awayShow === null && stayedAway && backShow === 'Show explanation',
      JSON.stringify({ hiddenNow, awayShow, stayedAway, backShow }));
    check('the Show button brings the explanation back from the save (no new request) and goes away', !!reopened && showAfter === null && state.claude.length === 1,
      `reopened:${!!reopened} show:${showAfter} requests:${state.claude.length}`);
    // drag-selecting a phrase doesn't also open an explanation
    await page.click('.zimu-explain .zimu-x-hide');
    const ws = await page.$$('.zimu-w');
    const wa = await ws[1].boundingBox();
    const wb = await ws[3].boundingBox();
    await page.mouse.move(wa.x + wa.width / 2, wa.y + wa.height / 2);
    await page.mouse.down();
    await page.mouse.move(wb.x + wb.width / 2, wb.y + wb.height / 2, { steps: 5 });
    await page.mouse.up();
    await sleep(500);
    check('drag-selecting a phrase opens only the phrase popup', await page.evaluate(() => !!document.querySelector('.zimu-popup') && !document.querySelector('.zimu-explain')));
    await page.keyboard.press('Escape');

    // every explanation lands in the flashcards' Sentences tab
    await cards.bringToFront();
    await cards.click('#tab-sentences');

    // review mode comes first: the line on the front, the answer on reveal
    const srFront = await waitFor(() => cards.evaluate(() => {
      const card = document.getElementById('sr-card');
      return !card.hidden ? { line: document.getElementById('sr-line').textContent, backHidden: document.getElementById('sr-back').hidden, due: document.getElementById('sentence-due').textContent } : null;
    }), 4000);
    await cards.keyboard.press('Space');
    const answer = await cards.evaluate(() => ({
      py: document.getElementById('sr-py').textContent,
      en: document.getElementById('sr-en').textContent,
      x: document.getElementById('sr-x').innerText,
    }));
    await cards.screenshot({ path: path.join(OUT, '9-sentence-review.png') });
    await cards.keyboard.press('2'); // Good
    const graded = await waitFor(() => cards.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      const rec = Object.entries(all).find(([k]) => k.startsWith('s:'))[1];
      return !document.getElementById('sr-empty').hidden && rec.box === 1 && rec.due > Date.now()
        ? { box: rec.box, due: document.getElementById('sentence-due').textContent, updated: rec.updated >= rec.reviewed } : null;
    }), 4000);
    check('sentence review: line on the front, pinyin/subtitle/explanation on reveal, Good schedules it',
      !!srFront && srFront.line === '你今天想去哪儿吃饭？' && srFront.backHidden && srFront.due === '1' &&
      answer.py.includes('nǐ jīntiān') && answer.en.includes('Where do you want') && /erhua/.test(answer.x) &&
      !!graded && graded.due === '0' && graded.updated, JSON.stringify({ srFront, graded }));

    await cards.click('#sent-mode-all');
    const listed = await waitFor(() => cards.evaluate(() => {
      const items = [...document.querySelectorAll('.sentence-item')];
      return items.length === 1 ? { zh: items[0].querySelector('.sentence-zh').textContent, x: items[0].querySelector('.explanation').innerText, play: !!items[0].querySelector('.play'), count: document.getElementById('sentence-count').textContent } : null;
    }), 4000);
    check('Sentences tab lists the explained line with its explanation and ▶', !!listed && listed.zh === '你今天想去哪儿吃饭？' && /erhua/.test(listed.x) && listed.play && listed.count === '1', JSON.stringify(listed));
    await cards.screenshot({ path: path.join(OUT, '8-sentences.png') });
    await page.bringToFront();

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

    // nothing for Zimu to show: only the disabled switch, and the video stays clear
    await cardsSet({ speed: 85 });
    const plain = await browser.newPage();
    const plainUi = () => plain.evaluate(() => {
      const vis = (el) => !!el && el.getClientRects().length > 0;
      const sw = document.querySelector('.zimu-osd-toggle');
      return {
        lines: vis(document.querySelector('.zimu-lines')),
        rest: [...document.querySelectorAll('.zimu-osd button, .zimu-osd .zimu-speed-box')].filter((el) => el !== sw && vis(el)).map((el) => el.title || el.className),
        sw: sw && { visible: vis(sw), disabled: sw.disabled, title: sw.title },
        rate: document.querySelector('video').playbackRate,
      };
    });
    // what the two track menus in the settings panel offer
    const readMenus = () => plain.evaluate(() => {
      const [zh, en] = [...document.querySelectorAll('.zimu-panel select')].map((s) => ({
        disabled: s.disabled,
        chosen: s.selectedOptions[0] && s.selectedOptions[0].textContent,
        options: [...s.options].map((o) => o.textContent),
      }));
      return { zh, en };
    });
    const clickTune = () => plain.evaluate(() => document.querySelector('.zimu-osd-tune').click());
    const trackMenus = async () => {
      await clickTune();
      const menus = await readMenus();
      await clickTune();
      return menus;
    };
    const eatsKey = (key) => plain.evaluate((k) => {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      return e.defaultPrevented;
    }, key);
    const settledOn = (re) => waitFor(async () => {
      const ui = await plainUi();
      return ui.sw && re.test(ui.sw.title) ? ui : null;
    }, 6000);
    state.item = 'item-no-subs';
    await plain.goto(`${BASE}/web/index.html#/video`);
    const noSubs = (await settledOn(/This video has no subtitles/)) || (await plainUi());
    await plain.screenshot({ path: path.join(OUT, '10-no-subtitles.png') });
    check('no subtitles: only the disabled switch shows, nothing over the video, 100% speed, keys go to Jellyfin',
      !noSubs.lines && !noSubs.rest.length && noSubs.sw.visible && noSubs.sw.disabled && noSubs.rate === 1 && !(await eatsKey('q')), JSON.stringify(noSubs));

    // tracks exist but none is Chinese: the track menu stays reachable to pick one
    state.item = 'item-english-only';
    await plain.reload();
    const noZh = (await settledOn(/No Chinese subtitle track/)) || (await plainUi());
    check('no Chinese track: the switch and track menu only, nothing over the video',
      !noZh.lines && noZh.rest.length === 1 && /subtitle settings/.test(noZh.rest[0]) && noZh.sw.disabled, JSON.stringify(noZh));
    const noZhMenus = await trackMenus();
    check('no Chinese track: the menus say so instead of offering a Chinese source that isn’t there',
      noZhMenus.zh.chosen === 'No Chinese text track' && noZhMenus.zh.options.includes('English') &&
      noZhMenus.en.disabled && noZhMenus.en.chosen === 'Pick a Chinese track first' && !noZhMenus.en.options.some((o) => /bilingual/.test(o)),
      JSON.stringify(noZhMenus));

    // the next video in the same tab has Chinese subtitles: everything comes back
    state.item = 'item1';
    await plain.evaluate(() => { const v = document.querySelector('video'); v.load(); v.play(); });
    const restored = await waitFor(async () => {
      const ui = await plainUi();
      return ui.lines && ui.rest.length > 1 && !ui.sw.disabled && Math.abs(ui.rate - 0.85) < 1e-9 ? ui : null;
    }, 6000);
    check('Zimu comes back on the next video with Chinese subtitles', !!restored, JSON.stringify(restored || (await plainUi())));
    const zhOnlyMenus = await trackMenus();
    check('a Chinese track with no English in it isn’t offered as an English source',
      !zhOnlyMenus.en.disabled && zhOnlyMenus.en.chosen === 'English' && !zhOnlyMenus.en.options.some((o) => /bilingual/.test(o)),
      JSON.stringify(zhOnlyMenus));

    // a bilingual Chinese track is offered, and only while it's the one in use
    state.item = 'item-bilingual';
    await plain.reload();
    await waitFor(async () => { const { sw } = await plainUi(); return sw && !sw.disabled; }, 6000);
    await clickTune();
    const bothMenus = await readMenus();
    check('a bilingual Chinese track is the English source', /bilingual/.test(bothMenus.en.chosen), JSON.stringify(bothMenus));
    await plain.select('.zimu-panel select', '3');
    const afterSwitch = await waitFor(async () => {
      const m = await readMenus();
      return m.zh.chosen === 'Chinese only' && !m.en.options.some((o) => /bilingual/.test(o)) ? m : null;
    }, 3000);
    check('switching to a plain Chinese track updates the open English menu', !!afterSwitch, JSON.stringify(afterSwitch || (await readMenus())));
    state.item = 'item1';
    await plain.close();
    await cardsSet({ speed: 100 });

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

    // ---- sync between Macs, through the Jellyfin server --------------------
    const pushed = await waitFor(() => {
      const keys = Object.keys(state.prefs);
      return keys.includes('c:吃饭') && keys.some((k) => k.startsWith('s:')) ? keys : null;
    }, 15000, 200);
    check('this Mac’s card and sentence reach the Jellyfin server', !!pushed, (pushed || Object.keys(state.prefs)).join(' '));

    // the other Mac: reviews 吃饭, adds 学习, deletes the sentence
    const t0 = Date.now() - 500; // just before now, so a delete made here afterwards is newer
    const sKey = Object.keys(state.prefs).find((k) => k.startsWith('s:'));
    const chifan = JSON.parse(state.prefs['c:吃饭']);
    state.prefs['c:吃饭'] = JSON.stringify({ ...chifan, box: 4, updated: t0 });
    state.prefs['c:学习'] = JSON.stringify({ id: 'other1', hanzi: '学习', pinyin: 'xuéxí', english: 'to study', created: t0, updated: t0, box: 0, due: 0 });
    delete state.prefs[sKey];
    state.prefs[`d:${sKey}`] = String(t0);
    await cards.bringToFront();
    await cards.click('#sync-now');
    const pulled = await waitFor(() => cards.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      const byHanzi = Object.fromEntries((all.cards || []).map((c) => [c.hanzi, c]));
      const sentences = Object.keys(all).filter((k) => k.startsWith('s:')).length;
      return byHanzi['学习'] && byHanzi['吃饭'].box === 4 && sentences === 0
        ? { cards: Object.keys(byHanzi), status: document.getElementById('sync-status').textContent } : null;
    }), 8000, 200);
    check('the other Mac’s review, new card and deletion arrive here', !!pulled && /Synced/.test(pulled.status), JSON.stringify(pulled));

    // deleting here reaches the server (sync runs a few seconds after a change)
    await cards.click('#tab-list');
    await cards.evaluate(() => {
      const row = [...document.querySelectorAll('#rows tr')].find((tr) => tr.textContent.includes('学习'));
      row.querySelector('button[title="Delete card"]').click();
    });
    const deletedRemote = await waitFor(() => (!state.prefs['c:学习'] && state.prefs['d:c:学习'] ? true : null), 10000, 200);
    check('a deletion here reaches the server', !!deletedRemote, Object.keys(state.prefs).join(' '));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  console.log(`screenshots: ${OUT}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

# Zimu 字幕

Mandarin learning subtitles for the **Jellyfin web player**, in the spirit of
Language Learning with Netflix. A browser extension for Chrome, Brave and
Zen/Firefox.

- **Hanzi, pinyin with tone marks and English**, each switchable on its own
  (hanzi + pinyin, English + pinyin, pinyin only, …). Pinyin is
  context-aware (还 hái/huán, 睡着 shuìzháo, 哪儿 nǎr).
- **Click a word** for its CC-CEDICT definitions, a character breakdown and
  a 🔊 pronunciation — and Zimu plays the moment that word is said in the
  video (▶ Hear it replays it). Subtitles only time whole lines, so the
  word's moment is estimated from its position in the line (Mandarin runs at
  about one syllable per character); a short margin either side covers most
  misses. Turn it off under ⚙ if you only want definitions.
- **Drag across words** (or shift-click) to look up a phrase: machine
  translation and a word-by-word breakdown.
- **Hover the subtitle box (not a word)** and Claude explains the line: a
  literal gloss, what it really means in context, how the English subtitle
  got there (and what it loosened or missed), and any slang, idioms or
  grammar worth knowing (小鲜肉 "little fresh meat" → a handsome young
  actor). Cut-off lines get a best guess at where they were heading.
  Needs your Anthropic API key (🗂 → Settings); uses Claude Opus 5.5 at low
  effort, about 1¢ per new line, and each line is explained once and saved.
- **☆ Save** a word or phrase to flashcards. Each card keeps the sentence,
  its pinyin and English, and the **exact moment in the video**.
- **Flashcards** (toolbar icon or 🗂 on the overlay): spaced-repetition
  review, and **▶ Play** jumps your Jellyfin tab to that line and stops at
  its end so you can hear it again. Export to Anki (each row carries a link
  that plays the moment) or back up/restore as JSON.
- Line navigation like LLN: **A** previous line, **S** repeat, **D** next,
  **Q** pause at the end of every line.
- **Speed** from 60% to 100% in 1% steps: − / + on the toolbar, **[ ]** (1%)
  and **{ }** (5%), or the slider under ⚙. Pitch is kept, so voices sound
  natural, just slower. Click the percentage to go back to 100%.
- Hovering the subtitles doesn't pause (turn "Pause while the mouse is over
  the subtitles" on under ⚙ if you want it).

Explanations go straight from the extension to api.anthropic.com with your
key, which stays in the browser's extension storage. Sending a request
needs the browser's "Access your data for api.anthropic.com" permission;
Zen asks for it with the same Grant access banner.

English comes from, in order: the English half of a bilingual Chinese
track, an English subtitle track, or machine translation (Google Translate's
public endpoint, sent only the Chinese line text).

## Install

```sh
cd ~/Code/zimu
npm install
npm run build      # fetches CC-CEDICT, vendors pinyin-pro,
                   # bundles bg/ (with the Anthropic SDK) into src/
```

**Chrome / Brave:** `chrome://extensions` → Developer mode → Load unpacked →
pick `~/Code/zimu/src`.

**Zen / Firefox:** `npm run package`, then drag `dist/zimu-0.3.0.xpi` onto
the browser (unsigned add-ons need `xpinstall.signatures.required = false`
in `about:config`), or load `src/manifest.json` temporarily from
`about:debugging` → This Firefox.

Then play something in Jellyfin that has a **text** Chinese subtitle track
(SRT/ASS/VTT, embedded or external). Zimu reads the track itself; it picks a
Chinese and an English track automatically and hides Jellyfin's own
subtitles. ⚙ on the overlay changes tracks and display.

## Servers

The extension runs on `https://jellyfin.example.com`, `http://jellyfin-host:*`, `http://192.0.2.10:*`,
`localhost` and `127.0.0.1`. To use another address, add it to
`host_permissions`, `content_scripts.matches` and
`web_accessible_resources.matches` in `src/manifest.json` and reload.

## Limits

- Image subtitles (PGS, VobSub) can't be read; you need a text track.
  The OpenSubtitles plugin on the server can fetch one.
- Flashcards live in the browser's extension storage: they don't sync
  between browsers or Macs yet. Back up/Restore moves them by hand.
- Segmentation is dictionary-based (bidirectional maximum matching), so the
  occasional word boundary will be off.

## How it works

The content script borrows the web client's own login from
`localStorage` (`jellyfin_credentials`, `_deviceId2`), asks the server what
this tab's session is playing (`/Sessions`), fetches the subtitle tracks as
JSON (`/Videos/{id}/{source}/Subtitles/{index}/Stream.js`) and draws its own
layer over the `<video>`. Playing a card in a tab that isn't already on that
video uses the same remote-control command a phone uses to cast to the
browser (`POST /Sessions/{id}/Playing`).

## Development

```sh
npm test                 # unit tests (pinyin, cues, segmentation, scheduling)
node test/e2e/run.js     # Chrome for Testing + a fake Jellyfin and
                         # Anthropic endpoint, 26 checks,
                         # screenshots in ./e2e-out
node test/e2e/run.js --firefox   # same in Firefox Developer Edition
```

## Credits

- [CC-CEDICT](https://www.mdbg.net/chinese/dictionary?page=cc-cedict),
  CC BY-SA 4.0.
- [pinyin-pro](https://github.com/zh-lx/pinyin-pro), MIT.

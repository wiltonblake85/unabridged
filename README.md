# Unabridged

A Chrome extension that reads any web page, Google Doc, Google Slides deck, PowerPoint deck on SharePoint or OneDrive for work, or PDF aloud with no length limit, in a natural voice that runs on your own machine. It is a spoken-word player that happens to show text: minutes left as the headline number, a chapter strip built from the page's own headings, the spoken word lit up on the page and in the transcript, and your place kept in every document for 90 days.

Nothing you read leaves your computer. There is no account, no server, and no per-word bill.

## Three voices, one switch

| Engine | What it is | Setup | Quality |
|---|---|---|---|
| **Built in** | Kokoro, an open neural voice model, running inside Chrome on your GPU (or CPU) | One download, about 320 MB, on first run | Good. Clearly above system voices. |
| **Voicebox** | Any voice profile in the [Voicebox](https://github.com/jamiepine/voicebox) app on your Mac, including voices you cloned from your own recordings | Install Voicebox, create a profile, keep the app open | Best with a cloned voice. Chatterbox and Qwen3-TTS class. |
| **Mac** | The voices installed on macOS, through Chrome's own speech API | None | Instant, lower quality. |

Switch between them under **Voice** in the panel. Playback, speed, and position memory work the same with all three. Word-by-word highlighting comes only from the Mac voices, because Chrome reports real word boundaries for those and the other two engines return audio with no timing; rather than guess, they light up the sentence.

## Install (one time, about 2 minutes)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (toggle, top right).
3. Click **Load unpacked** (top left).
4. Pick this folder (`Unabridged`) and click **Select**.
5. Click the puzzle-piece icon in the Chrome toolbar, find **Unabridged**, and click the pin so its icon stays visible.

The extension stays installed across Chrome restarts. If you ever move or rename the folder, repeat steps 3 and 4.

**First run.** The panel opens on one screen with one button, **Read this page**. The built-in voice downloads the first time you press play (about 320 MB, once; it is cached by Chrome) and the download progress shows in the panel while it fetches. Choose **Get a better voice first** to pick an engine and audition voices before reading anything.

### Optional: read local PDF files

To read a PDF you opened from your Mac (a `file://` address), go to `chrome://extensions`, click **Details** under Unabridged, and turn on **Allow access to file URLs**. PDFs opened from the web need nothing extra.

### Optional: your own voice through Voicebox (parked)

The Voicebox engine is in the code but hidden from the Voice panel for now, until it reads without pauses on a laptop. To try it, open the panel's DevTools console and run `chrome.storage.local.get('settings', s => chrome.storage.local.set({ settings: { ...s.settings, voiceboxEnabled: true } }))`, then reopen the panel.

1. Install [Voicebox](https://github.com/jamiepine/voicebox) and open it. It runs a local server on `127.0.0.1:17493`.
2. In Voicebox, create a voice profile: clone one from a short recording, or pick a preset.
3. In Unabridged, open **Voice**, choose **Voicebox**, and pick the profile. Samples play through Voicebox.

Voicebox generates a whole sentence before it sends any audio, so Unabridged keeps six sentences generated ahead of the one playing. If a model still has to be downloaded, the panel says so and shows it happening; the first sentence after that takes longest while the model loads. The **Generator** picker under the voice list applies to cloned voices: **Turbo** (Chatterbox Turbo) is the one most likely to keep up with playback on a laptop, **Qwen** sounds best and is slowest. If Voicebox turns out to generate slower than it plays on your Mac, the panel tells you the measured ratio once rather than leaving you to guess why there are pauses.

## Using it

**The toolbar icon** opens a small player: the ring, the title, minutes left, the chapter strip, and previous / next. Press **Open the panel** for the full reader, or **Read this page** when nothing is playing yet.

**The side panel** is five parts, top to bottom. The terracotta now-playing block holds a pressable progress ring (play and pause), the document kind and title, minutes left at your current speed and voice, and the chapter strip: one segment per section, sized by how long each section takes to read, with the past filled, the current one part-filled, and the rest translucent. Click any segment to jump to that section. Below it, one row of controls: back a sentence, forward a sentence, **Contents**, **Voice**. Then the transcript, where read text drops back, the current sentence stays lit, and with a Mac voice the spoken word inverts as it is said. Click any sentence to jump there.

**Contents** lists the page's own headings with how long each section takes and where you are in the current one. For PDFs, each page is a section. From here you can also open the **Still reading** library or open the document in a full tab.

**Voice** is where you audition voices by hearing them (press play on any row), switch engines, set speed, choose whether the transcript scrolls as it reads or holds still, and find the sleep timer, pronunciation rules, queue behavior, and shortcuts.

**Start reading a page.** Click the icon and press play, or press **Option+Shift+R** on any page. The panel shows the tab's title and an estimated time before you commit.

**Start from a specific spot.** Right-click any paragraph and choose **Read aloud from here**, or hold **Option** and click a paragraph.

**PowerPoint in the browser.** PowerPoint for the web draws slides inside a locked editor frame, so Unabridged downloads the .pptx the tab points at and reads the slide text itself. This works on SharePoint and OneDrive for work, OneDrive personal (onedrive.live.com and 1drv.ms links), and the Microsoft 365 launcher (powerpoint.cloud.microsoft). Decks read as one chapter per slide, named by its title, title first and then top to bottom. Hidden slides are skipped. Speaker notes are not read. Decks whose owner blocked downloads, and old .ppt files, fall back to Read the selection.

**Read only what you selected.** Highlight text, then right-click and choose **Read selection aloud**, or press **Option+Shift+S**.

**On the page.** The current sentence takes a warm tint and the spoken word inverts. A floating controller at the bottom of the page shows minutes left and a progress bar with previous, play, and next. Drag it anywhere, or press the arrow to tuck it into the edge of the window. It can be turned off under Voice.

**The full-tab reader.** Right-click a page and choose **Open in the Unabridged reader**, or press **Open in a full tab** under Contents. Contents sits in a sidebar, the text gets a wider, larger measure, and the player becomes a bar across the bottom. This is the surface for Google Docs and PDFs, where on-page highlighting cannot work.

**Coming back later.** Unabridged remembers where you stopped in every page and document for 90 days, on this Mac and, through Chrome sync, on any other computer where you are signed into the same Chrome profile. **Still reading** (under Contents, or the panel's home when nothing is playing) lists everything you stopped partway, with a ring showing how far you got, and everything you finished. Opening a document you were partway through resumes automatically with a **Picked up where you stopped on Thursday** ribbon and a **Start over** button. Resume after a pause longer than 30 seconds and it backs up one sentence first, the way an audiobook app does.

**Minutes left.** The estimate starts at 180 words per minute times your speed, then measures how fast the voice actually reads, voice by voice, and gets more accurate as you listen.

**The queue.** Right-click any page and choose **Add this page to the Unabridged queue**, or right-click a link and choose **Add link to the Unabridged queue**; the toolbar icon shows how many are waiting. Queued pages appear under **Up next** in Still reading. **Play all** reads them back to back: each opens in a background tab, reads through, and closes when done (a setting), then the next one starts.

**Stop reading after.** Under Voice, choose **Section** to stop at the next heading (never mid-sentence), or 15, 30, or 60 minutes. Your place is kept either way.

**Pronunciation.** Under Voice, add a name or term as it is written and how it should be said, for example `Wekesa → Weh-KAY-sah`. Rules apply to whole words in any capitalization, and the on-page highlight still lands on the original word.

**Keyboard.** Space in the panel plays and pauses; left and right arrows step back and forward one sentence, as do **Option+Shift+,** and **Option+Shift+.** from anywhere in Chrome. Tab reaches the ring, then previous, next, Contents, Voice, and the transcript, where Enter on a sentence seeks to it.

**Google Docs and Slides.** The full document is exported as text (no 2,000-word limit) and read from the transcript, which follows along. On-page highlighting does not work in Docs because Google draws the page as an image rather than text, so the transcript or the full-tab reader is the place to follow.

**PDFs.** Text is pulled page by page. Page markers appear in the transcript but are not spoken, and each page is a section in Contents.

## Changing the keyboard shortcuts

Go to `chrome://extensions/shortcuts`, find Unabridged, and set whatever keys you want.

## How it works

Text is extracted from the page's own DOM (or Google's export endpoint, or pdf.js for PDFs), grouped into chapters at the page's headings, split into sentences, and fed to the voice engine one sentence at a time while the next three are synthesized ahead, so a 300,000-word page reads exactly like a 300-word one. The built-in engine is [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) through [Transformers.js](https://github.com/huggingface/transformers.js) and [kokoro-js](https://github.com/hexgrad/kokoro), running in a worker on WebGPU where available and multi-threaded WASM otherwise. Highlighting uses the CSS Custom Highlight API, so the page's DOM is never modified.

## Files

- `manifest.json`: extension definition and permissions.
- `background.js`: context menus, keyboard shortcuts, opens the panel.
- `content.js`: runs on every page; extracts text, highlights, handles clicks.
- `panel.html`, `panel.css`, `panel.js`: the side panel. `panel.js` also drives `reader.html`.
- `reader.html`: the full-tab reader, same module with a wider layout.
- `popup.html`, `popup.js`: the toolbar player.
- `engine.js`, `kokoro-worker.js`: the three voice engines.
- `text.js`: sentence splitting and spoken-form cleanup.
- `vendor/kokoro.bundle.mjs`, `vendor/ort/`: the Kokoro runtime (built by `build/build.sh`).
- `vendor/pdf.min.mjs`, `vendor/pdf.worker.min.mjs`: Mozilla pdf.js 4.10.38.
- `vendor/fonts/`: Lora and Figtree, bundled so the panel loads no remote fonts.
- `icons/`: toolbar and panel icons (the Broadcast ring: cream disc, terracotta play, light-orange outer ring).
- `store/`: Chrome Web Store listing assets. `icon-128.png` (96px artwork on a 128 canvas, as the store asks), `promo-small-440x280.png`, `promo-marquee-1400x560.png`, and a 512px master.

## Rebuilding the voice runtime

```
cd build && npm install && ./build.sh
```

This produces `vendor/kokoro.bundle.mjs` and copies the ONNX runtime files. The model weights themselves are fetched from Hugging Face on first run and cached by Chrome; a hidden `modelHost` setting can point at a mirror.

## Why this exists

Google Docs' built-in read-aloud stops at about 2,000 words, most reader extensions send your text to a server, and the good voices sit behind $10 to $30 a month. Unabridged keeps the reading on your machine, in a voice worth listening to, with no cap.

## Status

Built and tested for Chrome on macOS with Apple Silicon. It should work on Windows and Linux wherever Chrome has WebGPU or enough CPU for the WASM fallback, but that has not been verified. Issues and pull requests are welcome.

## License

MIT. pdf.js is Apache 2.0, copyright Mozilla. The built-in voice is [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad, Apache 2.0; its training data includes the SIWIS (CC BY 4.0) and Koniwa (CC BY 3.0) corpora, credited here as those licenses ask. Voicebox is MIT, copyright Jamie Pine. Transformers.js and kokoro-js are Apache 2.0. Lora and Figtree are under the SIL Open Font License. The interface is the "Broadcast" design on the Organic design system tokens.

## Known limits

- Chrome's own pages (`chrome://…`), the Chrome Web Store, and some sites that block extensions cannot be read directly. Selecting text and using Read the selection still works on most of them.
- Pages that redraw their content while reading (some live feeds) can lose on-page highlighting mid-read. The panel transcript keeps working.
- Content inside embedded frames (iframes) is skipped in this version.
- Word-by-word highlighting works with the Mac voices only. The built-in and Voicebox engines return audio without timing, so they highlight the sentence rather than guess at the word.
- Closing the side panel stops playback, unless the document is open in the full-tab reader, which plays on its own.
- The interface is light only. A dark theme is a separate design task.

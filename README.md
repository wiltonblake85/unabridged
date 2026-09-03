# Unabridged

A Chrome extension that reads any web page, Google Doc, Google Slides deck, or PDF aloud with no length limit, in a natural voice that runs on your own machine. It highlights the sentence and word being read, lets you start from wherever you click, remembers your place in every document, and runs at whatever speed you like.

Nothing you read leaves your computer. There is no account, no server, and no per-word bill.

## Three voices, one switch

| Engine | What it is | Setup | Quality |
|---|---|---|---|
| **Built in** | Kokoro, an open neural voice model, running inside Chrome on your GPU (or CPU) | One download, about 320 MB, on first run | Good. Clearly above system voices. |
| **Voicebox** | Any voice profile in the [Voicebox](https://github.com/jamiepine/voicebox) app on your Mac, including voices you cloned from your own recordings | Install Voicebox, create a profile, keep the app open | Best. Chatterbox and Qwen3-TTS class voices. |
| **Mac** | The voices installed on macOS, through Chrome's own speech API | None | Instant, lower quality. |

Switch between them in Settings (the gear icon). Playback, highlighting, speed, and position memory work the same with all three.

## Install (one time, about 2 minutes)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (toggle, top right).
3. Click **Load unpacked** (top left).
4. Pick this folder (`Unabridged`) and click **Select**.
5. Click the puzzle-piece icon in the Chrome toolbar, find **Unabridged**, and click the pin so its icon stays visible.

The extension stays installed across Chrome restarts. If you ever move or rename the folder, repeat steps 3 and 4.

**First run.** The panel asks you to pick a voice and download the model (about 320 MB, once; it is cached by Chrome). Press **Use the Mac's built-in voices instead** if you want to skip that for now; you can run setup again from Settings any time.

### Optional: read local PDF files

To read a PDF you opened from your Mac (a `file://` address), go to `chrome://extensions`, click **Details** under Unabridged, and turn on **Allow access to file URLs**. PDFs opened from the web need nothing extra.

### Optional: your own voice through Voicebox

1. Install [Voicebox](https://github.com/jamiepine/voicebox) and open it. It runs a local server on `127.0.0.1:17493`.
2. In Voicebox, create a voice profile: clone one from a short recording, or pick a preset.
3. In Unabridged, open Settings, choose **Voicebox**, and pick the profile. Samples play through Voicebox.

Voicebox has to be open while you listen. If it is not running, Unabridged says so and you can switch engines.

## Using it

**Start reading a page.** Click the Unabridged icon to open the panel, then **Read this page**. Or press **Option+Shift+R** on any page. The panel shows the tab's word count and how long it will take at your current speed before you commit.

**Start from a specific spot.** Right-click any paragraph and choose **Read aloud from here**, hold **Option** and click a paragraph, or press **Start where I click** in the panel and then click a paragraph.

**Read only what you selected.** Highlight text, then right-click and choose **Read selection aloud**, or press **Option+Shift+S**.

**While it reads.** The current sentence is highlighted on the page and in the panel transcript, and the current word glows inside it. Click any sentence in the transcript to jump there. The speed chip cycles through 1.0×, 1.2×, 1.5×, 1.8×, 2×, 2.5×, 3×, and 0.8×; the slider in Settings goes anywhere from 0.5× to 3×. Space bar in the panel plays and pauses; left and right arrows step back and forward one sentence, as do **Option+Shift+,** and **Option+Shift+.** from anywhere in Chrome.

**Coming back later.** Unabridged remembers where you stopped in every page and document for 90 days. The panel's home screen lists the last three; press play on one and it opens the page and resumes. Opening a document you were partway through resumes automatically, with a **Start over** link if you want the top.

**Google Docs and Slides.** The full document is exported as text (no 2,000-word limit) and read from the panel transcript, which follows along. On-page highlighting does not work in Docs because Google draws the page as an image rather than text, so the transcript is the place to follow.

**PDFs.** Text is pulled page by page. Page markers appear in the transcript but are not spoken.

## Changing the keyboard shortcuts

Go to `chrome://extensions/shortcuts`, find Unabridged, and set whatever keys you want.

## How it works

Text is extracted from the page's own DOM (or Google's export endpoint, or pdf.js for PDFs), split into sentences, and fed to the voice engine one sentence at a time while the next three are synthesized ahead, so a 300,000-word page reads exactly like a 300-word one. The built-in engine is [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) through [Transformers.js](https://github.com/huggingface/transformers.js) and [kokoro-js](https://github.com/hexgrad/kokoro), running in a worker on WebGPU where available and multi-threaded WASM otherwise. Highlighting uses the CSS Custom Highlight API, so the page's DOM is never modified.

## Files

- `manifest.json`: extension definition and permissions.
- `background.js`: context menus, keyboard shortcuts, opens the panel.
- `content.js`: runs on every page; extracts text, highlights, handles clicks.
- `panel.html`, `panel.css`, `panel.js`: the reader.
- `engine.js`, `kokoro-worker.js`: the three voice engines.
- `text.js`: sentence splitting and spoken-form cleanup.
- `vendor/kokoro.bundle.mjs`, `vendor/ort/`: the Kokoro runtime (built by `build/build.sh`).
- `vendor/pdf.min.mjs`, `vendor/pdf.worker.min.mjs`: Mozilla pdf.js 4.10.38.
- `vendor/fonts/`: Newsreader and IBM Plex Sans, bundled so the panel loads no remote fonts.
- `icons/`: toolbar icons.

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

MIT. pdf.js is Apache 2.0, copyright Mozilla. Kokoro-82M is Apache 2.0. Transformers.js and kokoro-js are Apache 2.0. Newsreader and IBM Plex Sans are under the SIL Open Font License.

## Known limits

- Chrome's own pages (`chrome://…`), the Chrome Web Store, and some sites that block extensions cannot be read directly. Selecting text and using Read the selection still works on most of them.
- Pages that redraw their content while reading (some live feeds) can lose on-page highlighting mid-read. The panel transcript keeps working.
- Content inside embedded frames (iframes) is skipped in this version.
- Word highlighting with the built-in and Voicebox voices is timed by word length, not by the model, so it can drift a little within a sentence.
- Closing the side panel stops playback.

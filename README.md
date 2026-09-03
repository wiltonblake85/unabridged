# Unabridged

A Chrome extension that reads any web page, Google Doc, Google Slides deck, or PDF aloud with no length limit. It highlights the sentence being read, lets you start from wherever you click, remembers your place, and runs at whatever speed you like.

It uses the voices already installed on your Mac through Chrome's own speech API. It does not use VoiceOver or Spoken Content. Nothing leaves your machine.

## Install (one time, about 2 minutes)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (toggle, top right).
3. Click **Load unpacked** (top left).
4. Pick this folder (`Unabridged`) and click **Select**.
5. Click the puzzle-piece icon in the Chrome toolbar, find **Unabridged**, and click the pin so its icon stays visible.

That is it. The extension stays installed across Chrome restarts. If you ever move or rename the folder, repeat steps 3 and 4.

### Optional: read local PDF files

To read a PDF you opened from your Mac (a `file://` address), go to `chrome://extensions`, click **Details** under Unabridged, and turn on **Allow access to file URLs**. PDFs opened from the web need nothing extra.

### Optional but recommended: a better voice

Chrome can only use voices that are installed on the Mac. The default ones are fine; the Premium and Enhanced ones are noticeably better. To add one:

1. Open **System Settings → Accessibility → Spoken Content**.
2. Next to **System Voice**, open the dropdown and choose **Manage Voices…**.
3. Under English (US), download **Ava (Premium)**, **Zoe (Premium)**, or **Evan (Enhanced)**. Each is a few hundred MB.
4. Quit and reopen Chrome. The new voice appears in the Unabridged voice list.

This only downloads a voice file. Spoken Content itself stays off; the extension never turns it on.

## Using it

**Start reading a page.** Click the Unabridged icon to open the panel, then **Read this page**. Or press **Alt+Shift+R** (Option+Shift+R) on any page.

**Start from a specific spot.** Three ways:
- Right-click any paragraph and choose **Read aloud from here**.
- Hold **Option** and click a paragraph.
- In the panel, click **Start where I click**, then click a paragraph.

**Read only what you selected.** Highlight text, then right-click and choose **Read selection aloud**, or press **Alt+Shift+S**.

**While it reads.** The current sentence is highlighted on the page and in the panel transcript. Click any sentence in the transcript to jump there. Use the speed slider (0.5x to 3x) any time; it takes effect on the next sentence. Space bar in the panel plays and pauses. Left and right arrows step back and forward one sentence, as do **Alt+Shift+,** and **Alt+Shift+.** from anywhere.

**Coming back later.** Unabridged remembers where you stopped in every page and document for 90 days. Open it again and press Read this page; it resumes and offers **Start over** in case you want the top.

**Google Docs and Slides.** The full document is exported as text (no 2,000-word limit) and read from the panel transcript, which follows along. On-page highlighting does not work in Docs because Google draws the page as an image rather than text, so the transcript is the place to follow.

**PDFs.** Text is pulled page by page. Page markers appear in the transcript but are not spoken.

## Changing the keyboard shortcuts

Go to `chrome://extensions/shortcuts`, find Unabridged, and set whatever keys you want.

## Files

- `manifest.json`: extension definition and permissions.
- `background.js`: context menus, keyboard shortcuts, opens the panel.
- `content.js`: runs on every page; extracts text, highlights, handles clicks.
- `panel.html`, `panel.css`, `panel.js`: the player and transcript.
- `vendor/pdf.min.mjs`, `vendor/pdf.worker.min.mjs`: Mozilla pdf.js 4.10.38, used for PDFs.
- `icons/`: toolbar icons.

## Why this exists

Google Docs' built-in read-aloud stops at about 2,000 words, and most reader extensions send your text to a server. Unabridged keeps the reading on your machine and never hands the voice engine more than one sentence at a time, so a 300,000-word page reads exactly like a 300-word one.

## Status

Early. Built and tested for Chrome on macOS. It should work on Windows and Linux wherever Chrome can see system voices, but that has not been verified. Issues and pull requests are welcome.

## License

MIT. pdf.js is Apache 2.0, copyright Mozilla.

## Known limits

- Chrome's own pages (`chrome://…`), the Chrome Web Store, and some sites that block extensions cannot be read directly. Selecting text and using Read selection still works on most of them.
- Pages that redraw their content while reading (some live feeds) can lose on-page highlighting mid-read. The panel transcript keeps working.
- Content inside embedded frames (iframes) is skipped in this version.

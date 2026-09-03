// Unabridged - side panel player.
// The panel owns playback: it pulls text from the active tab (or exports a
// Google Doc, or parses a PDF), splits it into sentence-sized units, and feeds
// them to chrome.tts one at a time. No length limit, because nothing is ever
// sent to the voice engine in one piece.

// ---------- sentence splitting ----------
const ABBR = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc', 'e.g', 'i.e', 'cf', 'al',
  'inc', 'ltd', 'co', 'corp', 'llc', 'no', 'nos', 'fig', 'figs', 'approx', 'dept', 'est', 'ave',
  'blvd', 'rd', 'u.s', 'u.k', 'a.m', 'p.m', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep',
  'sept', 'oct', 'nov', 'dec', 'gen', 'col', 'lt', 'sgt', 'capt', 'rev', 'hon', 'ph.d', 'm.d', 'b.a',
  'm.a', 'vol', 'ch', 'pp', 'p', 'ed', 'eds', 'op', 'ca', 'min', 'max', 'sec', 'misc', 'govt'
]);
const MAX_UNIT = 300;

function isAbbrevBefore(text, dotIndex) {
  let k = dotIndex - 1;
  while (k >= 0 && !/\s/.test(text[k])) k--;
  let token = text.slice(k + 1, dotIndex).toLowerCase().replace(/^[("'“‘\[]+/, '');
  if (!token) return false;
  if (ABBR.has(token)) return true;
  if (/^[a-z]$/.test(token)) return true;            // initials: J. K. Rowling
  if (/^[a-z]\.[a-z]$/.test(token)) return true;      // U.S
  return false;
}

// Returns [{start, end}] offsets into `text` (raw offsets preserved).
function splitSentences(text) {
  const out = [];
  const n = text.length;
  const push = (s, e) => {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) out.push({ start: s, end: e });
  };
  let start = 0;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      let j = i + 1;
      while (j < n && /[.!?…"'”’)\]]/.test(text[j])) j++;
      if (j >= n) { push(start, n); start = n; break; }
      if (/\s/.test(text[j])) {
        if (ch === '.' && isAbbrevBefore(text, i)) { i = j; continue; }
        let k = j;
        while (k < n && /\s/.test(text[k])) k++;
        if (k < n && /\p{Ll}/u.test(text[k])) { i = j; continue; }
        push(start, j);
        start = k; i = k; continue;
      }
      i = j; continue;
    }
    i++;
  }
  if (start < n) push(start, n);
  return out.flatMap((s) => splitLong(text, s.start, s.end));
}

function splitLong(text, start, end) {
  if (end - start <= MAX_UNIT) return [{ start, end }];
  const parts = [];
  let s = start;
  while (end - s > MAX_UNIT) {
    const window = text.slice(s, s + MAX_UNIT);
    let cut = -1;
    // Prefer the last clause boundary after the first 100 chars.
    const m = [...window.matchAll(/[,;:—–]\s/g)].map((x) => x.index + 1).filter((x) => x > 100);
    if (m.length) cut = m[m.length - 1];
    if (cut < 0) {
      const sp = window.lastIndexOf(' ');
      cut = sp > 60 ? sp : MAX_UNIT;
    }
    parts.push({ start: s, end: s + cut });
    s = s + cut;
    while (s < end && /\s/.test(text[s])) s++;
  }
  if (s < end) parts.push({ start: s, end });
  return parts;
}

// Build the spoken form of a raw slice plus a map spoken-index -> raw offset.
function prepareSpoken(raw) {
  const map = [];
  let text = '';
  let lastSpace = true;
  const urlRe = /(https?:\/\/|www\.)[^\s)>\]"']+/gi;
  let idx = 0;
  const segments = [];
  let m;
  while ((m = urlRe.exec(raw)) !== null) {
    if (m.index > idx) segments.push({ kind: 'text', start: idx, end: m.index });
    segments.push({ kind: 'url', start: m.index, end: m.index + m[0].length });
    idx = m.index + m[0].length;
  }
  if (idx < raw.length) segments.push({ kind: 'text', start: idx, end: raw.length });
  for (const seg of segments) {
    if (seg.kind === 'url') {
      if (!lastSpace) { text += ' '; map.push(seg.start); }
      for (const c of 'link') { text += c; map.push(seg.start); }
      lastSpace = false;
      continue;
    }
    for (let i = seg.start; i < seg.end; i++) {
      const c = raw[i];
      if (/\s/.test(c)) {
        if (!lastSpace) { text += ' '; map.push(i); lastSpace = true; }
        continue;
      }
      text += c; map.push(i); lastSpace = false;
    }
  }
  // Drop citation brackets like [12] and stray markdown emphasis characters.
  const cleaned = [];
  const cmap = [];
  const cite = /\[\d{1,3}\]/g;
  const skip = new Set();
  let cm;
  while ((cm = cite.exec(text)) !== null) for (let k = cm.index; k < cm.index + cm[0].length; k++) skip.add(k);
  for (let k = 0; k < text.length; k++) {
    if (skip.has(k)) continue;
    if (text[k] === '*' || text[k] === '_' || text[k] === '#') continue;
    cleaned.push(text[k]); cmap.push(map[k]);
  }
  // Tidy gaps left by removals: "details ." -> "details.", double spaces -> one.
  const out = []; const omap = [];
  for (let k = 0; k < cleaned.length; k++) {
    const c = cleaned[k];
    if (c === ' ') {
      const next = cleaned[k + 1];
      if (next === undefined || next === ' ' || /[.,;:!?)\]]/.test(next)) continue;
      if (!out.length) continue;
    }
    out.push(c); omap.push(cmap[k]);
  }
  return { text: out.join(''), map: omap };
}

// ---------- state ----------
const state = {
  tabId: null, windowId: null, url: '', key: '', gen: 0, kind: null, title: '',
  canHighlight: false, blocks: [], units: [], idx: 0,
  playing: false, paused: false, token: 0, loading: false,
  settings: { rate: 1, voiceName: '', followPanel: true, allVoices: false },
  voices: [], lastHandledTs: 0, staleNoticed: false
};

const $ = (id) => document.getElementById(id);
const els = {
  docKind: $('docKind'), docTitle: $('docTitle'), notice: $('notice'), resume: $('resume'),
  resumeText: $('resumeText'), btnResume: $('btnResume'), btnStartOver: $('btnStartOver'),
  btnReadPage: $('btnReadPage'), btnReadSelection: $('btnReadSelection'), btnPick: $('btnPick'),
  btnPrev: $('btnPrev'), btnPlay: $('btnPlay'), btnNext: $('btnNext'), btnStop: $('btnStop'),
  progressFill: $('progressFill'), progressMeta: $('progressMeta'),
  rate: $('rate'), rateLabel: $('rateLabel'), voice: $('voice'),
  followPanel: $('followPanel'), allVoices: $('allVoices'),
  transcript: $('transcript'), emptyState: $('emptyState')
};

function notice(msg, isError) {
  if (!msg) { els.notice.hidden = true; els.notice.textContent = ''; return; }
  els.notice.hidden = false;
  els.notice.textContent = msg;
  els.notice.classList.toggle('error', !!isError);
}

// ---------- settings ----------
async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  if (settings) Object.assign(state.settings, settings);
  els.rate.value = state.settings.rate;
  els.rateLabel.textContent = `${Number(state.settings.rate).toFixed(1)}x`;
  els.followPanel.checked = !!state.settings.followPanel;
  els.allVoices.checked = !!state.settings.allVoices;
}
function saveSettings() {
  chrome.storage.local.set({ settings: state.settings });
}

// ---------- voices ----------
const PREFERRED = ['Ava', 'Zoe', 'Evan', 'Samantha', 'Allison', 'Tom', 'Nathan', 'Alex', 'Daniel', 'Karen'];
function loadVoices() {
  return new Promise((resolve) => {
    chrome.tts.getVoices((voices) => {
      state.voices = (voices || []).filter((v) => v.voiceName);
      renderVoices();
      resolve();
    });
  });
}
function renderVoices() {
  const all = state.settings.allVoices;
  let list = state.voices.filter((v) => all || !v.lang || /^en/i.test(v.lang));
  if (!list.length) list = state.voices;
  // Premium/Enhanced voices first, then alphabetical.
  const score = (v) => (/premium/i.test(v.voiceName) ? 0 : /enhanced/i.test(v.voiceName) ? 1 : 2);
  list.sort((a, b) => score(a) - score(b) || a.voiceName.localeCompare(b.voiceName));
  els.voice.innerHTML = '';
  for (const v of list) {
    const o = document.createElement('option');
    o.value = v.voiceName;
    o.textContent = v.lang ? `${v.voiceName} (${v.lang})` : v.voiceName;
    els.voice.appendChild(o);
  }
  if (!state.settings.voiceName || !list.some((v) => v.voiceName === state.settings.voiceName)) {
    let pick = null;
    for (const p of PREFERRED) {
      pick = list.find((v) => v.voiceName.toLowerCase().startsWith(p.toLowerCase()));
      if (pick) break;
    }
    if (!pick) pick = list.find((v) => /^en[-_]US/i.test(v.lang || '')) || list[0];
    state.settings.voiceName = pick ? pick.voiceName : '';
  }
  els.voice.value = state.settings.voiceName;
  if (!state.voices.length) notice('No voices found. On a Mac, download a voice under System Settings → Accessibility → Spoken Content → System Voice, then restart Chrome.', true);
}

// ---------- tab + content script ----------
async function getTab(tabId) {
  if (typeof tabId === 'number') {
    try { return await chrome.tabs.get(tabId); } catch (_) {}
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function ping(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ra:ping' });
    return !!(r && r.ok);
  } catch (_) { return false; }
}

async function ensureContentScript(tabId) {
  if (await ping(tabId)) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (_) { return false; }
  return ping(tabId);
}

function positionKey(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'docs.google.com') return `pos:${u.origin}${u.pathname.replace(/\/(edit|view|preview).*$/, '')}`;
    return `pos:${u.origin}${u.pathname}${u.search}`;
  } catch (_) { return `pos:${url}`; }
}

// ---------- loading a document ----------
async function loadFromTab(tabId, opts = {}) {
  if (state.loading) return false;
  state.loading = true;
  notice('');
  try {
    const tab = await getTab(tabId);
    if (!tab) { notice('No active tab found.', true); return false; }
    if (/^(chrome|edge|about|chrome-extension):/i.test(tab.url || '')) {
      notice('Chrome does not allow reading its own internal pages. Open a website, doc, or PDF.', true);
      return false;
    }
    setDocHeader('Loading…', tab.title || tab.url || '');
    const hasScript = await ensureContentScript(tab.id);
    let doc = null;
    const looksPdf = /\.pdf(?:[?#].*)?$/i.test(tab.url || '');
    if (hasScript && !looksPdf) {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'ra:extract' });
      if (res && !res.ok && res.googleExport) {
        doc = await loadGoogleExport(res.googleExport);
      } else {
        if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'Could not read this page.');
        doc = res;
      }
    } else {
      doc = await loadPdf(tab.url);
    }
    if (!doc.blocks || !doc.blocks.length) throw new Error('No readable text found on this page. Try selecting text and using Read selection.');
    applyDocument(tab, doc);
    await decideStart(opts);
    return true;
  } catch (e) {
    notice(e && e.message ? e.message : String(e), true);
    setDocHeader('Error', '');
    return false;
  } finally {
    state.loading = false;
  }
}

async function loadSelection(tabId, fallbackText) {
  notice('');
  const tab = await getTab(tabId);
  if (!tab) return false;
  let text = '';
  if (await ensureContentScript(tab.id)) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'ra:getSelection' });
      text = (r && r.text) || '';
    } catch (_) {}
  }
  if (!text.trim()) text = fallbackText || '';
  if (!text.trim()) { notice('Select some text on the page first, then press Read selection.', true); return false; }
  const blocks = text.split(/\r?\n+/).map((t) => t.trim()).filter(Boolean).map((t) => ({ text: t, heading: false }));
  applyDocument(tab, { kind: 'selection', title: `Selection from ${tab.title || 'page'}`, canHighlight: false, blocks, gen: 0 }, { noMemory: true });
  state.idx = 0;
  play();
  return true;
}

function applyDocument(tab, doc, o = {}) {
  stopSpeech();
  state.tabId = tab.id;
  state.windowId = tab.windowId;
  state.url = tab.url || '';
  state.key = o.noMemory ? '' : positionKey(state.url);
  state.gen = doc.gen || 0;
  state.kind = doc.kind;
  state.title = doc.title || tab.title || '';
  state.canHighlight = !!doc.canHighlight;
  state.staleNoticed = false;
  state.blocks = doc.blocks;
  state.units = [];
  state.idx = 0;
  doc.blocks.forEach((b, bi) => {
    if (b.silent) return;
    for (const s of splitSentences(b.text)) {
      const raw = b.text.slice(s.start, s.end);
      const sp = prepareSpoken(raw);
      if (!sp.text) continue;
      state.units.push({ b: bi, start: s.start, end: s.end, spoken: sp.text, map: sp.map, words: sp.text.split(/\s+/).length });
    }
  });
  const kindLabel = { page: 'Web page', gdoc: 'Google Doc', gslides: 'Google Slides', pdf: 'PDF', selection: 'Selection' }[doc.kind] || 'Document';
  const wordTotal = state.units.reduce((a, u) => a + u.words, 0);
  setDocHeader(`${kindLabel} · ${wordTotal.toLocaleString()} words · ${state.units.length.toLocaleString()} sentences`, state.title);
  renderTranscript();
  updateProgress();
  els.resume.hidden = true;
}

function setDocHeader(kind, title) {
  els.docKind.textContent = kind;
  els.docTitle.textContent = title;
  els.docTitle.title = title;
}

async function decideStart(opts) {
  // Explicit start point (click / context menu) wins. Otherwise resume a saved
  // position if there is one, else start at the top.
  if (typeof opts.blockIndex === 'number') {
    const i = state.units.findIndex((u) => u.b >= opts.blockIndex);
    state.idx = i >= 0 ? i : 0;
    play();
    return;
  }
  const saved = state.key ? (await chrome.storage.local.get(state.key))[state.key] : null;
  if (saved && saved.idx > 0 && saved.idx < state.units.length - 1) {
    state.idx = Math.min(saved.idx, state.units.length - 1);
    els.resume.hidden = false;
    els.resumeText.textContent = `Resumed at sentence ${state.idx + 1} of ${state.units.length}.`;
    els.btnResume.hidden = true;
    els.btnStartOver.hidden = false;
  } else {
    state.idx = 0;
  }
  if (opts.autoplay !== false) play();
  else markCurrent();
}

// ---------- Google Docs fallback (export fetched from the extension itself) ----------
async function loadGoogleExport(info) {
  const res = await fetch(info.url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Google export failed (HTTP ${res.status}). Make sure you are signed in to Google in this Chrome profile and have at least view access.`);
  let text = await res.text();
  text = text.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { kind: info.kind, title: info.title, canHighlight: false, blocks: lines.map((t) => ({ text: t, heading: false })), gen: 0 };
}

// ---------- PDF ----------
async function loadPdf(url) {
  if (!url) throw new Error('No URL for this tab.');
  let res;
  try { res = await fetch(url, { credentials: 'include' }); } catch (e) {
    if (/^file:/i.test(url)) throw new Error('To read local PDF files, open chrome://extensions, click Details on Unabridged, and turn on "Allow access to file URLs".');
    throw new Error(`Could not fetch this document (${e.message}).`);
  }
  if (!res.ok) throw new Error(`Could not fetch this document (HTTP ${res.status}).`);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 5));
  const isPdf = ct.includes('pdf') || String.fromCharCode(...head) === '%PDF-';
  if (!isPdf) throw new Error('This page cannot be read directly (no content script access and not a PDF). Try selecting text and using Read selection.');
  setDocHeader('Parsing PDF…', url.split('/').pop());
  const pdfjs = await import(chrome.runtime.getURL('vendor/pdf.min.mjs'));
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.mjs');
  const pdf = await pdfjs.getDocument({ data: buf, isEvalSupported: false }).promise;
  const blocks = [];
  let title = '';
  try { const meta = await pdf.getMetadata(); title = (meta.info && meta.info.Title) || ''; } catch (_) {}
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const lines = [];
    let cur = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      cur += item.str;
      if (item.hasEOL) { lines.push(cur); cur = ''; }
      else if (item.str && !/\s$/.test(item.str)) cur += ' ';
    }
    if (cur.trim()) lines.push(cur);
    blocks.push({ text: `Page ${p} of ${pdf.numPages}`, silent: true });
    let para = '';
    for (let raw of lines) {
      const line = raw.replace(/\s+/g, ' ').trim();
      if (!line) { if (para) { blocks.push({ text: para, heading: false }); para = ''; } continue; }
      if (para.endsWith('-') && /^[a-z]/.test(line)) para = para.slice(0, -1) + line;
      else para = para ? `${para} ${line}` : line;
      if (/[.!?:]["'”’)\]]?$/.test(line) || line.length < 45) { blocks.push({ text: para, heading: false }); para = ''; }
    }
    if (para) blocks.push({ text: para, heading: false });
  }
  return { kind: 'pdf', title: title || url.split('/').pop().split('?')[0], canHighlight: false, blocks, gen: 0 };
}

// ---------- transcript ----------
function renderTranscript() {
  els.transcript.innerHTML = '';
  const frag = document.createDocumentFragment();
  let unitIdx = 0;
  state.blocks.forEach((b, bi) => {
    const p = document.createElement('p');
    if (b.silent) { p.className = 'silent'; p.textContent = b.text; frag.appendChild(p); return; }
    if (b.heading) p.className = 'heading';
    frag.appendChild(p);
    let any = false;
    while (unitIdx < state.units.length && state.units[unitIdx].b === bi) {
      const u = state.units[unitIdx];
      const span = document.createElement('span');
      span.className = 's';
      span.dataset.i = String(unitIdx);
      span.textContent = b.text.slice(u.start, u.end).replace(/\s+/g, ' ');
      p.appendChild(span);
      p.appendChild(document.createTextNode(' '));
      u.el = span;
      unitIdx++;
      any = true;
    }
    if (!any) p.textContent = b.text.replace(/\s+/g, ' ').trim();
  });
  els.transcript.appendChild(frag);
}

els.transcript.addEventListener('click', (e) => {
  const s = e.target.closest('.s');
  if (!s) return;
  state.idx = Number(s.dataset.i);
  play();
});

function markCurrent() {
  const cur = els.transcript.querySelector('.s.current');
  if (cur) { cur.classList.remove('current'); cur.classList.add('read'); }
  const u = state.units[state.idx];
  if (u && u.el) {
    u.el.classList.add('current');
    u.el.classList.remove('read');
    if (state.settings.followPanel) {
      const r = u.el.getBoundingClientRect();
      const box = els.transcript.getBoundingClientRect();
      if (r.top < box.top + 40 || r.bottom > box.bottom - 80) u.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  updateProgress();
}

function updateProgress() {
  const total = state.units.length;
  if (!total) { els.progressFill.style.width = '0%'; els.progressMeta.textContent = '–'; return; }
  const pct = Math.round(((state.idx) / total) * 100);
  els.progressFill.style.width = `${pct}%`;
  let wordsLeft = 0;
  for (let i = state.idx; i < total; i++) wordsLeft += state.units[i].words;
  const mins = wordsLeft / (165 * state.settings.rate);
  const left = mins < 1 ? 'under a minute left' : mins < 60 ? `~${Math.round(mins)} min left` : `~${Math.floor(mins / 60)} h ${Math.round(mins % 60)} min left`;
  els.progressMeta.innerHTML = `<span>Sentence ${state.idx + 1} of ${total}</span><span>${left}</span>`;
}

// ---------- playback ----------
function setPlayingUI() {
  els.btnPlay.innerHTML = state.playing && !state.paused ? '&#10074;&#10074;' : '&#9654;';
}

function play() {
  if (!state.units.length) { loadFromTab(null, {}); return; }
  if (state.idx >= state.units.length) state.idx = 0;
  state.playing = true;
  if (state.paused) { state.paused = false; chrome.tts.resume(); }
  speakCurrent();
}

function pause() {
  if (!state.playing || state.paused) return;
  state.paused = true;
  chrome.tts.pause();
  setPlayingUI();
}

function resume() {
  if (!state.paused) return;
  state.paused = false;
  chrome.tts.resume();
  setPlayingUI();
}

function togglePlay() {
  if (!state.units.length) { loadFromTab(null, {}); return; }
  if (state.playing && !state.paused) pause();
  else if (state.paused) resume();
  else play();
}

function stopSpeech() {
  state.token += 1;
  state.playing = false;
  state.paused = false;
  try { chrome.tts.stop(); } catch (_) {}
  setPlayingUI();
}

function stop() {
  stopSpeech();
  clearPageHighlight();
}

function speakCurrent() {
  const u = state.units[state.idx];
  if (!u) { finish(); return; }
  const myToken = ++state.token;
  if (state.paused) { state.paused = false; chrome.tts.resume(); }
  setPlayingUI();
  markCurrent();
  pageHighlight(u, null);
  savePosition();
  chrome.tts.speak(u.spoken, {
    rate: Number(state.settings.rate) || 1,
    voiceName: state.settings.voiceName || undefined,
    enqueue: false,
    onEvent: (ev) => {
      if (myToken !== state.token) return;
      if (ev.type === 'start') {
        state.errors = 0;
      } else if (ev.type === 'word') {
        if (typeof ev.charIndex === 'number') pageHighlight(u, wordRange(u, ev.charIndex, ev.length));
      } else if (ev.type === 'end') {
        if (!state.playing) return;
        if (state.idx < state.units.length - 1) { state.idx += 1; speakCurrent(); }
        else finish();
      } else if (ev.type === 'error') {
        state.errors = (state.errors || 0) + 1;
        if (state.errors >= 3) {
          stopSpeech();
          notice(`The voice engine failed three times in a row (${ev.errorMessage || 'unknown error'}). Pick a different voice and press play.`, true);
          return;
        }
        notice(`Voice error: ${ev.errorMessage || 'unknown'}. Skipping ahead.`, true);
        if (state.playing && state.idx < state.units.length - 1) { state.idx += 1; setTimeout(() => { if (myToken === state.token) speakCurrent(); }, 300); }
      }
    }
  }, () => {
    if (chrome.runtime.lastError) notice(`Could not start speech: ${chrome.runtime.lastError.message}`, true);
  });
}

function finish() {
  state.playing = false;
  state.paused = false;
  setPlayingUI();
  clearPageHighlight();
  if (state.key) chrome.storage.local.remove(state.key);
  els.resume.hidden = true;
  notice('Finished.');
}

function wordRange(u, charIndex, length) {
  if (charIndex < 0 || charIndex >= u.map.length) return null;
  let len = typeof length === 'number' && length > 0 ? length : 0;
  if (!len) {
    let k = charIndex;
    while (k < u.spoken.length && !/\s/.test(u.spoken[k])) k++;
    len = k - charIndex;
  }
  const endIdx = Math.min(charIndex + len - 1, u.map.length - 1);
  return { start: u.start + u.map[charIndex], end: u.start + u.map[endIdx] + 1 };
}

let lastHighlightKey = '';
async function pageHighlight(u, word) {
  if (!state.canHighlight || state.tabId === null) return;
  const key = `${state.idx}:${word ? word.start : ''}`;
  if (key === lastHighlightKey) return;
  lastHighlightKey = key;
  try {
    const r = await chrome.tabs.sendMessage(state.tabId, { type: 'ra:highlight', gen: state.gen, blockIndex: u.b, start: u.start, end: u.end, word });
    if (r && r.stale && !state.staleNoticed) {
      state.staleNoticed = true;
      state.canHighlight = false;
      notice('The page changed since it was loaded, so on-page highlighting is off. The transcript here still follows along.');
    }
  } catch (_) {
    state.canHighlight = false;
  }
}

function clearPageHighlight() {
  lastHighlightKey = '';
  if (state.tabId === null) return;
  chrome.tabs.sendMessage(state.tabId, { type: 'ra:clear' }).catch(() => {});
}

let saveTimer = null;
function savePosition() {
  if (!state.key) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [state.key]: { idx: state.idx, total: state.units.length, title: state.title, ts: Date.now() } });
  }, 500);
}

async function prunePositions() {
  const all = await chrome.storage.local.get(null);
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  const stale = Object.keys(all).filter((k) => k.startsWith('pos:') && all[k] && all[k].ts < cutoff);
  if (stale.length) chrome.storage.local.remove(stale);
}

function step(delta) {
  if (!state.units.length) return;
  state.idx = Math.max(0, Math.min(state.units.length - 1, state.idx + delta));
  if (state.playing) speakCurrent();
  else { markCurrent(); savePosition(); }
}

// ---------- requests from background / content ----------
async function handleRequest(p) {
  if (!p || !p.action) return { ok: false };
  if (p.ts && p.ts === state.lastHandledTs) return { ok: true, dup: true };
  if (p.ts) state.lastHandledTs = p.ts;
  chrome.storage.session.remove('pending').catch(() => {});
  chrome.runtime.sendMessage({ type: 'ra:clearBadge' }).catch(() => {});
  switch (p.action) {
    case 'readTab':
      await loadFromTab(p.tabId, { blockIndex: typeof p.blockIndex === 'number' ? p.blockIndex : undefined });
      return { ok: true };
    case 'readSelection':
      await loadSelection(p.tabId, p.fallbackText);
      return { ok: true };
    case 'togglePlay':
      if (!state.units.length) await loadFromTab(p.tabId, {});
      else togglePlay();
      return { ok: true };
    case 'prev': step(-1); return { ok: true };
    case 'next': step(1); return { ok: true };
    default: return { ok: false };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'ra:panel') {
    handleRequest(msg.payload).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

async function checkPending() {
  const { pending } = await chrome.storage.session.get('pending');
  if (pending && Date.now() - (pending.ts || 0) < 60000) await handleRequest(pending);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId) state.canHighlight = false;
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === state.tabId && info.status === 'loading' && info.url && info.url !== state.url) state.canHighlight = false;
});

// ---------- UI wiring ----------
els.btnReadPage.addEventListener('click', () => loadFromTab(null, {}));
els.btnReadSelection.addEventListener('click', () => loadSelection(null, ''));
els.btnPick.addEventListener('click', async () => {
  const tab = await getTab(null);
  if (!tab || !(await ensureContentScript(tab.id))) { notice('Cannot pick on this page. Try Option+click on a paragraph on a normal web page.', true); return; }
  const on = !els.btnPick.classList.contains('active');
  els.btnPick.classList.toggle('active', on);
  chrome.tabs.sendMessage(tab.id, { type: 'ra:pickMode', on }).catch(() => {});
  if (on) notice('Now click any paragraph on the page to start reading there.');
  else notice('');
});
els.btnPlay.addEventListener('click', togglePlay);
els.btnStop.addEventListener('click', stop);
els.btnPrev.addEventListener('click', () => step(-1));
els.btnNext.addEventListener('click', () => step(1));
els.btnResume.addEventListener('click', () => play());
els.btnStartOver.addEventListener('click', () => { state.idx = 0; els.resume.hidden = true; play(); });

els.rate.addEventListener('input', () => {
  state.settings.rate = Number(els.rate.value);
  els.rateLabel.textContent = `${state.settings.rate.toFixed(1)}x`;
  updateProgress();
});
els.rate.addEventListener('change', () => {
  saveSettings();
  if (state.playing && !state.paused) speakCurrent();
});
els.voice.addEventListener('change', () => {
  state.settings.voiceName = els.voice.value;
  saveSettings();
  if (state.playing && !state.paused) speakCurrent();
});
els.followPanel.addEventListener('change', () => { state.settings.followPanel = els.followPanel.checked; saveSettings(); });
els.allVoices.addEventListener('change', () => { state.settings.allVoices = els.allVoices.checked; saveSettings(); renderVoices(); });

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
});

window.addEventListener('unload', () => { try { chrome.tts.stop(); } catch (_) {} });

// ---------- boot ----------
(async () => {
  await loadSettings();
  await loadVoices();
  prunePositions();
  await checkPending();
  if (!state.units.length) {
    const tab = await getTab(null);
    if (tab && tab.title) setDocHeader('Ready', tab.title);
  }
})();

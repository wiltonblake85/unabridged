// Unabridged - side panel.
// Three states: Empty (nothing loaded), Setup (first-run voice download),
// Reading. The panel owns playback through engine.js and pulls text from the
// active tab (or exports a Google Doc, or parses a PDF) via content.js.

import { splitSentences, prepareSpoken } from './text.js';
import { SystemEngine, KokoroEngine, VoiceboxEngine, KOKORO_VOICES } from './engine.js';

// ---------- state ----------
const state = {
  view: 'empty',
  tabId: null, windowId: null, url: '', key: '', gen: 0, kind: null, title: '',
  canHighlight: false, blocks: [], units: [], idx: 0,
  playing: false, paused: false, waiting: false, loading: false,
  settings: {
    engine: 'kokoro', onboarded: false,
    kokoroVoice: 'af_heart', systemVoice: '', voiceboxVoice: '',
    rate: 1, followPanel: true, wordHighlight: true, allVoices: false, modelHost: ''
  },
  systemVoices: [], lastHandledTs: 0, staleNoticed: false, errors: 0,
  pickMode: false, pendingAfterSetup: null
};

const system = new SystemEngine();
let kokoro = null;
let voicebox = null;
let voiceboxVoices = [];
let voiceboxUp = null; // null unknown, true, false
let kokoroLoadState = 'idle'; // idle | loading | ready | failed

const $ = (id) => document.getElementById(id);
const els = {
  viewEmpty: $('viewEmpty'), viewSetup: $('viewSetup'), viewReading: $('viewReading'),
  emptyTitle: $('emptyTitle'), emptyMeta: $('emptyMeta'), recent: $('recent'), recentList: $('recentList'), noticeEmpty: $('noticeEmpty'),
  btnReadPage: $('btnReadPage'), btnReadSelection: $('btnReadSelection'), btnPick: $('btnPick'),
  setupLede: $('setupLede'), setupVoices: $('setupVoices'), setupHint: $('setupHint'), setupProgress: $('setupProgress'), setupFill: $('setupFill'), setupStatus: $('setupStatus'), setupBytes: $('setupBytes'), btnDownload: $('btnDownload'), btnUseSystem: $('btnUseSystem'), noticeSetup: $('noticeSetup'),
  docKind: $('docKind'), docTitle: $('docTitle'), resume: $('resume'), resumeText: $('resumeText'), btnStartOver: $('btnStartOver'), notice: $('notice'),
  transcript: $('transcript'), progressFill: $('progressFill'), progressPos: $('progressPos'), progressLeft: $('progressLeft'),
  chipVoice: $('chipVoice'), chipVoiceName: $('chipVoiceName'), chipSpeed: $('chipSpeed'), btnPrev: $('btnPrev'), btnPlay: $('btnPlay'), btnNext: $('btnNext'),
  scrim: $('scrim'), drawer: $('drawer'), btnCloseDrawer: $('btnCloseDrawer'), segEngine: $('segEngine'), engineHint: $('engineHint'), drawerVoices: $('drawerVoices'), allLangsWrap: $('allLangsWrap'), allVoices: $('allVoices'),
  rate: $('rate'), rateLabel: $('rateLabel'), followPanel: $('followPanel'), wordHighlight: $('wordHighlight'), btnStop: $('btnStop'), btnRerunSetup: $('btnRerunSetup'),
  btnSettings1: $('btnSettings1'), btnSettings2: $('btnSettings2')
};

function showView(v) {
  state.view = v;
  els.viewEmpty.hidden = v !== 'empty';
  els.viewSetup.hidden = v !== 'setup';
  els.viewReading.hidden = v !== 'reading';
}

function notice(msg, isError, where) {
  const el = where === 'empty' ? els.noticeEmpty : where === 'setup' ? els.noticeSetup : els.notice;
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false; el.textContent = msg; el.classList.toggle('error', !!isError);
}

// ---------- settings ----------
async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  if (settings) Object.assign(state.settings, settings);
  els.rate.value = state.settings.rate;
  els.rateLabel.textContent = fmtRate(state.settings.rate);
  els.chipSpeed.textContent = fmtRate(state.settings.rate);
  els.followPanel.checked = !!state.settings.followPanel;
  els.wordHighlight.checked = !!state.settings.wordHighlight;
  els.allVoices.checked = !!state.settings.allVoices;
}
function saveSettings() { chrome.storage.local.set({ settings: state.settings }); }
const fmtRate = (r) => `${Number(r).toFixed(1)}×`;

// ---------- engines ----------
function currentEngine() {
  const e = state.settings.engine;
  if (e === 'kokoro' && kokoro) return kokoro;
  if (e === 'voicebox') return ensureVoicebox();
  return system;
}
function currentVoice() {
  const e = state.settings.engine;
  return e === 'kokoro' ? state.settings.kokoroVoice : e === 'voicebox' ? state.settings.voiceboxVoice : state.settings.systemVoice;
}
function ensureVoicebox() { if (!voicebox) voicebox = new VoiceboxEngine(); return voicebox; }
async function refreshVoicebox() {
  const probe = await VoiceboxEngine.probe();
  voiceboxUp = probe.up;
  if (probe.up) {
    try { voiceboxVoices = await ensureVoicebox().voices(); } catch (_) { voiceboxVoices = []; }
    if (!state.settings.voiceboxVoice || !voiceboxVoices.some((v) => v.id === state.settings.voiceboxVoice)) {
      state.settings.voiceboxVoice = voiceboxVoices.length ? voiceboxVoices[0].id : '';
      saveSettings();
    }
  }
  updateEngineHint();
  renderVoiceLists();
}

function ensureKokoro() {
  if (kokoro) return kokoro;
  // modelHost is an optional hidden setting (a mirror or self-hosted copy of the model files).
  kokoro = new KokoroEngine({ onProgress: onKokoroProgress, remoteHost: state.settings.modelHost || null });
  return kokoro;
}

function onKokoroProgress(p) {
  if (p.status === 'ready') {
    kokoroLoadState = 'ready';
    els.setupStatus.textContent = 'Voice ready';
    els.setupFill.style.width = '100%';
    els.setupBytes.textContent = p.device === 'webgpu' ? 'Running on the GPU' : 'Running on the CPU';
    els.setupHint.textContent = 'Samples now play with the downloaded voice.';
    els.btnDownload.textContent = 'Start reading';
    els.btnDownload.disabled = false;
    updateEngineHint();
    return;
  }
  if (p.status === 'fallback') { els.setupBytes.textContent = 'GPU unavailable, using CPU'; return; }
  if (typeof p.total === 'number' && p.total > 0) {
    const pct = Math.min(100, Math.round((p.loaded / p.total) * 100));
    els.setupFill.style.width = `${pct}%`;
    els.setupBytes.textContent = `${fmtMB(p.loaded)} of ${fmtMB(p.total)} MB`;
    els.setupStatus.textContent = pct >= 100 ? 'Preparing the voice' : 'Downloading voice model';
  }
}
const fmtMB = (b) => Math.round(b / 1048576);

// Load Kokoro in the background (used at boot when already onboarded).
async function warmKokoro({ silent } = {}) {
  if (kokoroLoadState === 'ready' || kokoroLoadState === 'loading') return;
  kokoroLoadState = 'loading';
  updateEngineHint();
  try {
    await ensureKokoro().ready();
    kokoroLoadState = 'ready';
    if (state.view === 'reading') setPlayUI();
  } catch (e) {
    kokoroLoadState = 'failed';
    kokoro = null;
    if (!silent) notice(`The Unabridged voice could not load (${e && e.message ? e.message : e}). Using the Mac's voices for now.`, true);
    state.settings.engine = 'system';
    saveSettings();
  }
  updateEngineHint();
  renderVoiceLists();
}

function updateEngineHint() {
  const eng = state.settings.engine;
  let text = '';
  if (eng === 'kokoro') {
    text = kokoroLoadState === 'ready' ? `Local neural voice${kokoro && kokoro.device === 'webgpu' ? ', running on the GPU' : ''}. Nothing leaves this machine.`
      : kokoroLoadState === 'loading' ? 'Loading the voice model…'
      : kokoroLoadState === 'failed' ? 'The voice model failed to load. Try again from first-run setup.'
      : 'Not downloaded yet. Run first-run setup to fetch it.';
  } else if (eng === 'voicebox') {
    text = voiceboxUp === false ? 'Voicebox is not running. Open the Voicebox app on this Mac, then reopen Settings.'
      : voiceboxUp === true ? (voiceboxVoices.length ? `Connected to Voicebox. ${voiceboxVoices.length} voice profile${voiceboxVoices.length === 1 ? '' : 's'}, including any you cloned.` : 'Connected to Voicebox, but it has no voice profiles yet. Create one in the app.')
      : 'Looking for the Voicebox app on this Mac…';
  } else {
    text = 'Voices installed on this Mac. Instant, lower quality.';
  }
  els.engineHint.textContent = text;
  for (const b of els.segEngine.querySelectorAll('button')) b.classList.toggle('on', b.dataset.engine === eng);
}

// ---------- voices ----------
async function loadSystemVoices() {
  state.systemVoices = await system.voices();
  const preferred = ['Ava', 'Zoe', 'Evan', 'Samantha', 'Allison', 'Tom', 'Alex', 'Daniel', 'Karen'];
  if (!state.settings.systemVoice || !state.systemVoices.some((v) => v.id === state.settings.systemVoice)) {
    let pick = null;
    for (const p of preferred) { pick = state.systemVoices.find((v) => v.name.toLowerCase().startsWith(p.toLowerCase())); if (pick) break; }
    if (!pick) pick = state.systemVoices.find((v) => /^en/i.test(v.lang || '')) || state.systemVoices[0];
    state.settings.systemVoice = pick ? pick.id : '';
  }
}

function voiceRow(v, selected, compact) {
  const b = document.createElement('button');
  b.className = 'voice' + (selected ? ' selected' : '');
  b.dataset.id = v.id;
  b.innerHTML = `
    <span class="sample" data-sample="${v.id}" title="Play a sample"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg></span>
    <span class="t"><b></b><small></small></span>
    <svg class="check" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"></path></svg>`;
  b.querySelector('b').textContent = v.name;
  b.querySelector('small').textContent = v.note || '';
  return b;
}

function renderVoiceLists() {
  // Setup list: Kokoro voices only.
  els.setupVoices.innerHTML = '';
  for (const v of KOKORO_VOICES) els.setupVoices.appendChild(voiceRow(v, v.id === state.settings.kokoroVoice));
  // Drawer list: depends on engine.
  els.drawerVoices.innerHTML = '';
  if (state.settings.engine === 'kokoro') {
    for (const v of KOKORO_VOICES) els.drawerVoices.appendChild(voiceRow(v, v.id === state.settings.kokoroVoice, true));
    els.allLangsWrap.hidden = true;
  } else if (state.settings.engine === 'voicebox') {
    for (const v of voiceboxVoices) els.drawerVoices.appendChild(voiceRow(v, v.id === state.settings.voiceboxVoice, true));
    els.allLangsWrap.hidden = true;
  } else {
    const all = state.settings.allVoices;
    let list = state.systemVoices.filter((v) => all || !v.lang || /^en/i.test(v.lang));
    if (!list.length) list = state.systemVoices;
    const score = (v) => (/premium/i.test(v.name) ? 0 : /enhanced/i.test(v.name) ? 1 : 2);
    list.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
    for (const v of list) els.drawerVoices.appendChild(voiceRow(v, v.id === state.settings.systemVoice, true));
    els.allLangsWrap.hidden = false;
    if (!state.systemVoices.length) notice('No Mac voices found. Download one under System Settings → Accessibility → Spoken Content → System Voice, then restart Chrome.', true);
  }
  const eng = state.settings.engine;
  const name = eng === 'kokoro'
    ? (KOKORO_VOICES.find((v) => v.id === state.settings.kokoroVoice) || KOKORO_VOICES[0]).name
    : eng === 'voicebox'
      ? (voiceboxVoices.find((v) => v.id === state.settings.voiceboxVoice) || { name: 'Voicebox' }).name
      : (state.systemVoices.find((v) => v.id === state.settings.systemVoice) || { name: 'Voice' }).name.replace(/\s*\(.*\)$/, '');
  els.chipVoiceName.textContent = name;
}

function onVoiceListClick(e, listKind) {
  const sample = e.target.closest('[data-sample]');
  const row = e.target.closest('.voice');
  if (!row) return;
  const id = row.dataset.id;
  const isKokoroList = listKind === 'setup' || state.settings.engine === 'kokoro';
  const isVoiceboxList = !isKokoroList && state.settings.engine === 'voicebox';
  if (sample) { playSample(id, isKokoroList, isVoiceboxList); return; }
  if (isKokoroList) state.settings.kokoroVoice = id; else if (isVoiceboxList) state.settings.voiceboxVoice = id; else state.settings.systemVoice = id;
  saveSettings();
  renderVoiceLists();
  if (state.playing && !state.paused) speakCurrent();
}

const SAMPLE_TEXT = 'You do not have a sales problem. You have a diagnosis problem.';
let sampleToken = 0;
async function playSample(voiceId, isKokoro, isVoicebox) {
  const my = ++sampleToken;
  stopSpeech(true);
  const unit = { spoken: SAMPLE_TEXT };
  if (isVoicebox) {
    ensureVoicebox().speak(unit, { rate: state.settings.rate, voice: voiceId, onEnd: () => {}, onError: (m) => notice(m, true, state.view) });
  } else if (isKokoro && kokoroLoadState === 'ready' && kokoro) {
    kokoro.speak(unit, { rate: state.settings.rate, voice: voiceId, onEnd: () => {}, onError: (m) => notice(m, true, state.view) });
  } else {
    // Before the model is here, sample with the Mac voice so the button always does something.
    system.speak(unit, { rate: state.settings.rate, voice: isKokoro ? state.settings.systemVoice : voiceId, onEnd: () => {}, onError: () => {} });
  }
  void my;
}

// ---------- tab + content script ----------
async function getTab(tabId) {
  if (typeof tabId === 'number') { try { return await chrome.tabs.get(tabId); } catch (_) {} }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}
async function ping(tabId) {
  try { const r = await chrome.tabs.sendMessage(tabId, { type: 'ra:ping' }); return !!(r && r.ok); } catch (_) { return false; }
}
async function ensureContentScript(tabId) {
  if (await ping(tabId)) return true;
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); } catch (_) { return false; }
  return ping(tabId);
}
function positionKey(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'docs.google.com') return `pos:${u.origin}${u.pathname.replace(/\/(edit|view|preview).*$/, '')}`;
    return `pos:${u.origin}${u.pathname}${u.search}`;
  } catch (_) { return `pos:${url}`; }
}

// ---------- Empty view: describe the active tab ----------
let describeSeq = 0;
async function describeActiveTab() {
  const seq = ++describeSeq;
  const tab = await getTab(null);
  if (!tab || seq !== describeSeq) return;
  els.emptyTitle.textContent = tab.title || 'Open a page, doc, or PDF';
  els.emptyMeta.textContent = 'Then press Read this page';
  if (/^(chrome|edge|about|chrome-extension):/i.test(tab.url || '')) { els.emptyMeta.textContent = 'Chrome cannot read its own pages'; return; }
  if (!(await ensureContentScript(tab.id))) { els.emptyMeta.textContent = /\.pdf(?:[?#].*)?$/i.test(tab.url || '') ? 'PDF · press Read this page' : 'Press Read this page'; return; }
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'ra:extract' });
    if (seq !== describeSeq) return;
    if (r && r.ok && r.blocks) {
      const words = r.blocks.reduce((a, b) => a + (b.silent ? 0 : b.text.split(/\s+/).filter(Boolean).length), 0);
      const mins = Math.max(1, Math.round(words / (165 * state.settings.rate)));
      const kind = { page: 'Web page', gdoc: 'Google Doc', gslides: 'Google Slides' }[r.kind] || 'Page';
      els.emptyTitle.textContent = r.title || tab.title || '';
      els.emptyMeta.textContent = `${kind} · about ${words.toLocaleString()} words · ${mins} min at ${fmtRate(state.settings.rate)}`;
    }
  } catch (_) {}
}

async function renderRecent() {
  const all = await chrome.storage.local.get(null);
  const items = Object.entries(all).filter(([k, v]) => k.startsWith('pos:') && v && v.idx > 0).map(([k, v]) => ({ key: k, url: k.slice(4), ...v }))
    .sort((a, b) => b.ts - a.ts).slice(0, 3);
  els.recent.hidden = !items.length;
  els.recentList.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'recent-item';
    b.innerHTML = `<span class="t"><b></b><small></small></span><span class="go"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg></span>`;
    b.querySelector('b').textContent = it.title || it.url;
    b.querySelector('small').textContent = `Sentence ${it.idx + 1} of ${it.total} · ${relTime(it.ts)}`;
    b.addEventListener('click', () => openAndRead(it.url));
    els.recentList.appendChild(b);
  }
}
function relTime(ts) {
  const d = Date.now() - ts;
  const m = Math.round(d / 60000);
  if (m < 60) return m <= 1 ? 'just now' : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
async function openAndRead(url) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  let tab = tabs.find((t) => t.url && positionKey(t.url) === positionKey(url));
  if (tab) { await chrome.tabs.update(tab.id, { active: true }); await loadFromTab(tab.id, {}); return; }
  tab = await chrome.tabs.create({ url, active: true });
  await new Promise((resolve) => {
    const onUpd = (id, info) => { if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(onUpd); resolve(); } };
    chrome.tabs.onUpdated.addListener(onUpd);
    setTimeout(resolve, 15000);
  });
  await new Promise((r) => setTimeout(r, 400));
  await loadFromTab(tab.id, {});
}

// ---------- loading a document ----------
async function loadFromTab(tabId, opts = {}) {
  if (state.loading) return false;
  if (needsSetup()) { state.pendingAfterSetup = { action: 'readTab', tabId, blockIndex: opts.blockIndex }; showSetup(); return false; }
  state.loading = true;
  notice('');
  try {
    const tab = await getTab(tabId);
    if (!tab) { notice('No active tab found.', true, state.view); return false; }
    if (/^(chrome|edge|about|chrome-extension):/i.test(tab.url || '')) {
      notice('Chrome does not allow reading its own internal pages. Open a website, doc, or PDF.', true, state.view);
      return false;
    }
    const hasScript = await ensureContentScript(tab.id);
    let doc = null;
    const looksPdf = /\.pdf(?:[?#].*)?$/i.test(tab.url || '');
    if (hasScript && !looksPdf) {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'ra:extract' });
      if (res && !res.ok && res.googleExport) doc = await loadGoogleExport(res.googleExport);
      else {
        if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'Could not read this page.');
        doc = res;
      }
    } else {
      doc = await loadPdf(tab.url);
    }
    if (!doc.blocks || !doc.blocks.length) throw new Error('No readable text found on this page. Try selecting text and using Read the selection.');
    applyDocument(tab, doc);
    await decideStart(opts);
    return true;
  } catch (e) {
    notice(e && e.message ? e.message : String(e), true, state.view);
    return false;
  } finally {
    state.loading = false;
  }
}

async function loadSelection(tabId, fallbackText) {
  if (needsSetup()) { state.pendingAfterSetup = { action: 'readSelection', tabId, fallbackText }; showSetup(); return false; }
  notice('');
  const tab = await getTab(tabId);
  if (!tab) return false;
  let text = '';
  if (await ensureContentScript(tab.id)) {
    try { const r = await chrome.tabs.sendMessage(tab.id, { type: 'ra:getSelection' }); text = (r && r.text) || ''; } catch (_) {}
  }
  if (!text.trim()) text = fallbackText || '';
  if (!text.trim()) { notice('Select some text on the page first, then press Read the selection.', true, state.view); return false; }
  const blocks = text.split(/\r?\n+/).map((t) => t.trim()).filter(Boolean).map((t) => ({ text: t, heading: false }));
  applyDocument(tab, { kind: 'selection', title: `Selection from ${tab.title || 'page'}`, canHighlight: false, blocks, gen: 0 }, { noMemory: true });
  state.idx = 0;
  play();
  return true;
}

function applyDocument(tab, doc, o = {}) {
  stopSpeech();
  state.tabId = tab.id; state.windowId = tab.windowId; state.url = tab.url || '';
  state.key = o.noMemory ? '' : positionKey(state.url);
  state.gen = doc.gen || 0; state.kind = doc.kind; state.title = doc.title || tab.title || '';
  state.canHighlight = !!doc.canHighlight; state.staleNoticed = false;
  state.blocks = doc.blocks; state.units = []; state.idx = 0;
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
  els.docKind.textContent = `${kindLabel} · ${wordTotal.toLocaleString()} words`;
  els.docTitle.textContent = state.title;
  els.docTitle.title = state.title;
  renderTranscript();
  updateProgress();
  els.resume.hidden = true;
  showView('reading');
}

async function decideStart(opts) {
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
    els.resumeText.textContent = `Resumed at sentence ${state.idx + 1}.`;
  } else {
    state.idx = 0;
  }
  if (opts.autoplay !== false) play(); else markCurrent();
}

// ---------- Google Docs fallback ----------
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
  if (!isPdf) throw new Error('This page cannot be read directly (no content script access and not a PDF). Try selecting text and using Read the selection.');
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
    for (const raw of lines) {
      const line = raw.replace(/\s+/g, ' ').trim();
      if (!line) { if (para) { blocks.push({ text: para, heading: false }); para = ''; } continue; }
      if (para.endsWith('-') && /^[a-z]/.test(line)) para = para.slice(0, -1) + line;
      else para = para ? `${para} ${line}` : line;
      if (/[.!?:]["'”’)\]]?$/.test(line) || line.length < 45) { blocks.push({ text: para, heading: false }); para = ''; }
    }
    if (para) blocks.push({ text: para, heading: false });
  }
  if (!title || /^\(anonymous\)$/i.test(title)) title = url.split('/').pop().split('?')[0];
  return { kind: 'pdf', title, canHighlight: false, blocks, gen: 0 };
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
    u.el.classList.add('current'); u.el.classList.remove('read');
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
  if (!total) { els.progressFill.style.width = '0%'; els.progressPos.textContent = '–'; els.progressLeft.textContent = ''; return; }
  els.progressFill.style.width = `${Math.round((state.idx / total) * 100)}%`;
  let wordsLeft = 0;
  for (let i = state.idx; i < total; i++) wordsLeft += state.units[i].words;
  const mins = wordsLeft / (165 * state.settings.rate);
  els.progressPos.textContent = `Sentence ${state.idx + 1} of ${total}`;
  els.progressLeft.textContent = mins < 1 ? 'under a minute left' : mins < 60 ? `${Math.round(mins)} min left` : `${Math.floor(mins / 60)} h ${Math.round(mins % 60)} min left`;
}

// ---------- playback ----------
function setPlayUI() {
  const s = state.waiting ? 'waiting' : state.playing && !state.paused ? 'playing' : state.paused ? 'paused' : 'stopped';
  els.btnPlay.dataset.state = s;
}

function play() {
  if (!state.units.length) { loadFromTab(null, {}); return; }
  if (state.idx >= state.units.length) state.idx = 0;
  state.playing = true;
  if (state.paused) { state.paused = false; currentEngine().resume(); setPlayUI(); return; }
  speakCurrent();
}
function pause() {
  if (!state.playing || state.paused) return;
  state.paused = true;
  currentEngine().pause();
  setPlayUI();
}
function togglePlay() {
  if (!state.units.length) { loadFromTab(null, {}); return; }
  if (state.playing && !state.paused) pause();
  else play();
}
function stopSpeech(keepUI) {
  state.playing = false; state.paused = false; state.waiting = false;
  try { system.stop(); } catch (_) {}
  try { if (kokoro) kokoro.stop(); } catch (_) {}
  try { if (voicebox) voicebox.stop(); } catch (_) {}
  if (!keepUI) setPlayUI();
}
function stop() { stopSpeech(); clearPageHighlight(); }

let speakSeq = 0;
async function speakCurrent() {
  const u = state.units[state.idx];
  if (!u) { finish(); return; }
  const my = ++speakSeq;
  const engine = currentEngine();
  if (state.paused) { state.paused = false; engine.resume(); }
  markCurrent();
  pageHighlight(u, null);
  savePosition();
  state.waiting = engine.kind !== 'system';
  setPlayUI();
  if (engine.kind === 'kokoro' && kokoroLoadState !== 'ready') {
    try { await warmKokoro(); } catch (_) {}
    if (my !== speakSeq) return;
    if (kokoroLoadState !== 'ready') { state.waiting = false; speakCurrent(); return; } // engine switched to system
  }
  if (engine.kind === 'voicebox' && !currentVoice()) {
    await refreshVoicebox();
    if (my !== speakSeq) return;
    if (!currentVoice()) { stopSpeech(); notice(voiceboxUp ? 'Voicebox has no voice profiles yet. Create one in the Voicebox app, then press play.' : 'Voicebox is not running. Open the Voicebox app on this Mac, then press play.', true); return; }
  }
  const opts = {
    rate: Number(state.settings.rate) || 1,
    voice: currentVoice(),
    onStart: () => { if (my !== speakSeq) return; state.waiting = false; state.errors = 0; setPlayUI(); prefetchAhead(); },
    onWord: (ci, len) => { if (my !== speakSeq || !state.settings.wordHighlight) return; pageHighlight(u, wordRange(u, ci, len)); },
    onEnd: () => {
      if (my !== speakSeq || !state.playing) return;
      if (state.idx < state.units.length - 1) { state.idx += 1; speakCurrent(); } else finish();
    },
    onError: (msg) => {
      if (my !== speakSeq) return;
      state.errors += 1;
      if (state.errors >= 3) { stopSpeech(); notice(`The voice failed three times in a row (${msg}). Try another voice or engine in Settings.`, true); return; }
      notice(`Voice error: ${msg}. Skipping ahead.`, true);
      if (state.playing && state.idx < state.units.length - 1) { state.idx += 1; setTimeout(() => { if (my === speakSeq) speakCurrent(); }, 300); }
    }
  };
  engine.speak(u, opts);
}

function prefetchAhead() {
  const engine = currentEngine();
  if (engine.kind === 'system') return;
  engine.prefetch(state.units.slice(state.idx + 1, state.idx + 4), { rate: state.settings.rate, voice: currentVoice() });
}

function finish() {
  state.playing = false; state.paused = false; state.waiting = false;
  setPlayUI();
  clearPageHighlight();
  if (state.key) chrome.storage.local.remove(state.key);
  els.resume.hidden = true;
  notice('Finished.');
}

function wordRange(u, charIndex, length) {
  if (charIndex < 0 || charIndex >= u.map.length) return null;
  let len = typeof length === 'number' && length > 0 ? length : 0;
  if (!len) { let k = charIndex; while (k < u.spoken.length && !/\s/.test(u.spoken[k])) k++; len = k - charIndex; }
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
      state.staleNoticed = true; state.canHighlight = false;
      notice('The page changed since it was loaded, so on-page highlighting is off. The transcript here still follows along.');
    }
  } catch (_) { state.canHighlight = false; }
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
  if (state.playing) { state.paused = false; speakCurrent(); }
  else { markCurrent(); savePosition(); }
}

// ---------- setup (first run) ----------
function needsSetup() { return state.settings.engine === 'kokoro' && !state.settings.onboarded; }
function showSetup() {
  showView('setup');
  els.setupProgress.hidden = kokoroLoadState === 'idle';
  els.btnDownload.textContent = kokoroLoadState === 'ready' ? 'Start reading' : kokoroLoadState === 'loading' ? 'Start reading when ready' : 'Download the voice';
  els.btnDownload.disabled = kokoroLoadState === 'loading';
  renderVoiceLists();
}
async function startDownload() {
  if (kokoroLoadState === 'ready') { finishSetup(); return; }
  els.setupProgress.hidden = false;
  els.btnDownload.disabled = true;
  els.btnDownload.textContent = 'Start reading when ready';
  notice('', false, 'setup');
  kokoroLoadState = 'loading';
  updateEngineHint();
  try {
    await ensureKokoro().ready();
    kokoroLoadState = 'ready';
    finishSetup();
  } catch (e) {
    kokoroLoadState = 'failed';
    kokoro = null;
    els.btnDownload.disabled = false;
    els.btnDownload.textContent = 'Try again';
    notice(`The download did not finish (${e && e.message ? e.message : e}). Check your connection and try again, or use the Mac's voices.`, true, 'setup');
    updateEngineHint();
  }
}
function finishSetup() {
  state.settings.engine = 'kokoro';
  state.settings.onboarded = true;
  saveSettings();
  updateEngineHint();
  renderVoiceLists();
  const p = state.pendingAfterSetup;
  state.pendingAfterSetup = null;
  if (p) handleRequest(p); else { showView('empty'); describeActiveTab(); renderRecent(); }
}
function useSystemInstead() {
  state.settings.engine = 'system';
  state.settings.onboarded = true;
  saveSettings();
  updateEngineHint();
  renderVoiceLists();
  const p = state.pendingAfterSetup;
  state.pendingAfterSetup = null;
  if (p) handleRequest(p); else { showView('empty'); describeActiveTab(); renderRecent(); }
}

// ---------- requests from background / content ----------
async function handleRequest(p) {
  if (!p || !p.action) return { ok: false };
  if (p.ts && p.ts === state.lastHandledTs) return { ok: true, dup: true };
  if (p.ts) state.lastHandledTs = p.ts;
  chrome.storage.session.remove('pending').catch(() => {});
  chrome.runtime.sendMessage({ type: 'ra:clearBadge' }).catch(() => {});
  switch (p.action) {
    case 'readTab': await loadFromTab(p.tabId, { blockIndex: typeof p.blockIndex === 'number' ? p.blockIndex : undefined }); return { ok: true };
    case 'readSelection': await loadSelection(p.tabId, p.fallbackText); return { ok: true };
    case 'togglePlay': if (!state.units.length) await loadFromTab(p.tabId, {}); else togglePlay(); return { ok: true };
    case 'prev': step(-1); return { ok: true };
    case 'next': step(1); return { ok: true };
    default: return { ok: false };
  }
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'ra:panel') { handleRequest(msg.payload).then(sendResponse, () => sendResponse({ ok: false })); return true; }
  return false;
});
async function checkPending() {
  const { pending } = await chrome.storage.session.get('pending');
  if (pending && Date.now() - (pending.ts || 0) < 60000) { await handleRequest(pending); return true; }
  return false;
}
chrome.tabs.onRemoved.addListener((tabId) => { if (tabId === state.tabId) state.canHighlight = false; });
chrome.tabs.onUpdated.addListener((tabId, info) => { if (tabId === state.tabId && info.status === 'loading' && info.url && info.url !== state.url) state.canHighlight = false; });
chrome.tabs.onActivated.addListener(() => { if (state.view === 'empty') describeActiveTab(); });

// ---------- drawer ----------
function openDrawer() { els.drawer.hidden = false; els.scrim.hidden = false; renderVoiceLists(); updateEngineHint(); if (state.settings.engine === 'voicebox' || voiceboxUp === null) refreshVoicebox(); }
function closeDrawer() { els.drawer.hidden = true; els.scrim.hidden = true; }

// ---------- UI wiring ----------
els.btnReadPage.addEventListener('click', () => loadFromTab(null, {}));
els.btnReadSelection.addEventListener('click', () => loadSelection(null, ''));
els.btnPick.addEventListener('click', async () => {
  const tab = await getTab(null);
  if (!tab || !(await ensureContentScript(tab.id))) { notice('Cannot pick on this page. Try Option-click on a paragraph on a normal web page.', true, 'empty'); return; }
  state.pickMode = !state.pickMode;
  els.btnPick.classList.toggle('active', state.pickMode);
  chrome.tabs.sendMessage(tab.id, { type: 'ra:pickMode', on: state.pickMode }).catch(() => {});
  notice(state.pickMode ? 'Now click any paragraph on the page to start reading there.' : '', false, 'empty');
});
els.btnPlay.addEventListener('click', togglePlay);
els.btnPrev.addEventListener('click', () => step(-1));
els.btnNext.addEventListener('click', () => step(1));
els.btnStartOver.addEventListener('click', () => { state.idx = 0; els.resume.hidden = true; play(); });
els.btnStop.addEventListener('click', () => { stop(); closeDrawer(); });
els.btnSettings1.addEventListener('click', openDrawer);
els.btnSettings2.addEventListener('click', openDrawer);
els.btnCloseDrawer.addEventListener('click', closeDrawer);
els.scrim.addEventListener('click', closeDrawer);
els.btnRerunSetup.addEventListener('click', () => { closeDrawer(); state.pendingAfterSetup = null; showSetup(); });
els.btnDownload.addEventListener('click', startDownload);
els.btnUseSystem.addEventListener('click', useSystemInstead);
els.setupVoices.addEventListener('click', (e) => onVoiceListClick(e, 'setup'));
els.drawerVoices.addEventListener('click', (e) => onVoiceListClick(e, 'drawer'));
els.chipVoice.addEventListener('click', openDrawer);

const SPEED_PRESETS = [1, 1.2, 1.5, 1.8, 2, 2.5, 3, 0.8];
els.chipSpeed.addEventListener('click', () => {
  const cur = Number(state.settings.rate);
  const next = SPEED_PRESETS[(SPEED_PRESETS.findIndex((p) => Math.abs(p - cur) < 0.05) + 1) % SPEED_PRESETS.length];
  setRate(next, true);
});
function setRate(r, restart) {
  state.settings.rate = Number(r);
  els.rate.value = state.settings.rate;
  els.rateLabel.textContent = fmtRate(state.settings.rate);
  els.chipSpeed.textContent = fmtRate(state.settings.rate);
  updateProgress();
  saveSettings();
  if (restart && state.playing && !state.paused) speakCurrent();
}
els.rate.addEventListener('input', () => setRate(els.rate.value, false));
els.rate.addEventListener('change', () => setRate(els.rate.value, true));

els.segEngine.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-engine]');
  if (!b) return;
  const eng = b.dataset.engine;
  if (eng === state.settings.engine) return;
  const wasPlaying = state.playing && !state.paused;
  stopSpeech();
  state.settings.engine = eng;
  saveSettings();
  updateEngineHint();
  renderVoiceLists();
  if (eng === 'kokoro' && !state.settings.onboarded) { closeDrawer(); showSetup(); return; }
  if (eng === 'kokoro') warmKokoro();
  if (eng === 'voicebox') await refreshVoicebox();
  if (wasPlaying) play();
});
els.followPanel.addEventListener('change', () => { state.settings.followPanel = els.followPanel.checked; saveSettings(); });
els.wordHighlight.addEventListener('change', () => { state.settings.wordHighlight = els.wordHighlight.checked; saveSettings(); });
els.allVoices.addEventListener('change', () => { state.settings.allVoices = els.allVoices.checked; saveSettings(); renderVoiceLists(); });

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (e.key === 'Escape' && !els.drawer.hidden) { closeDrawer(); return; }
  if (state.view !== 'reading') return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
});
window.addEventListener('unload', () => { stopSpeech(true); });

// ---------- boot ----------
(async () => {
  await loadSettings();
  await loadSystemVoices();
  renderVoiceLists();
  updateEngineHint();
  prunePositions();
  const handled = await checkPending();
  if (!handled) {
    if (needsSetup()) showSetup();
    else { showView('empty'); describeActiveTab(); renderRecent(); }
  }
  if (state.settings.engine === 'kokoro' && state.settings.onboarded) warmKokoro({ silent: true });
  if (state.settings.engine === 'voicebox') refreshVoicebox();
})();

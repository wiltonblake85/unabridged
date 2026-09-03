// Unabridged: the reader ("Broadcast" design).
// One module drives two surfaces: the side panel (panel.html) and the
// full-tab reader (reader.html). The surface is read off <body data-surface>.
//
// Five parts, in order: now-playing block (ring, title, minutes left,
// chapter strip), an optional ribbon (resume / notices / download progress),
// the control strip, the body (transcript, or the Contents / Voice / Library
// panel swapped in), and a polite live region for screen readers.

import { splitSentences, prepareSpoken } from './text.js';
import { SystemEngine, KokoroEngine, VoiceboxEngine, VOICEBOX_ENGINES, KOKORO_VOICES } from './engine.js';

const SURFACE = document.body.dataset.surface || 'panel';
const SURFACE_ID = `${SURFACE}-${Math.random().toString(36).slice(2, 8)}`;

// ---------- state ----------
const state = {
  loaded: false,
  tabId: null, windowId: null, url: '', key: '', gen: 0, kind: null, title: '', source: '', pages: 0,
  canHighlight: false, blocks: [], units: [], idx: 0,
  chapters: [], chapterIdx: 0, wordRange: null,
  playing: false, paused: false, waiting: false, loading: false,
  panelView: 'reading', // reading | contents | voice | library
  followSuspended: false,
  settings: {
    engine: 'kokoro', onboarded: false,
    kokoroVoice: 'af_heart', systemVoice: '', voiceboxVoice: '', voiceboxEngine: 'auto', voiceboxEnabled: false,
    rate: 1, followPanel: true, wordHighlight: true, showController: true, modelHost: '',
    pronunciations: [], closeQueueTabs: true
  },
  wpm: {},              // key -> { w: words, s: seconds, n: sentences }
  sleep: { mode: 'off', until: 0 }, pausedAt: 0,
  queue: [], queueMode: false, queueCurrentId: null, queueOpenedTab: null,
  systemVoices: [], lastHandledTs: 0, staleNoticed: false, errors: 0,
  resumedFrom: null, // ts of the position we picked up from, for the ribbon
  libFilter: 'unfinished',
  activeTab: null    // description of the active tab when nothing is loaded
};

const system = new SystemEngine();
window.__ra = state; // debug hook
let kokoro = null;
let voicebox = null;
let voiceboxVoices = [];
let voiceboxUp = null; // null unknown, true, false
let voiceboxWarned = false;
let kokoroLoadState = 'idle'; // idle | loading | ready | failed
let kokoroProgress = null;

const $ = (id) => document.getElementById(id);
const ids = ['viewFirstRun', 'frRead', 'frVoice', 'viewReading', 'np', 'ring', 'ringFill', 'btnPlay', 'npKicker', 'npTitle', 'npMin', 'npSub', 'btnNpClose',
  'strip', 'capLeft', 'capRight', 'ribbon', 'ribbonIcon', 'ribbonMsg', 'ribbonBtn', 'ctl', 'btnPrev', 'btnNext', 'chipContents', 'chipVoice',
  'bodyWrap', 'transcript', 'btnJump', 'panelContents', 'toc', 'btnLibrary', 'btnReader', 'panelVoice', 'btnCloseVoice', 'segEngine', 'engineHint',
  'voiceList', 'btnOtherLangs', 'otherLangsLabel', 'voiceListOther', 'rate', 'rateLabel', 'followScroll', 'followStill', 'wordHighlight', 'showController',
  'segSleep', 'dictList', 'dictFrom', 'dictTo', 'btnDictAdd', 'closeQueueTabs', 'btnStop', 'btnRerunSetup', 'voiceFoot',
  'panelLibrary', 'btnCloseLibrary', 'segLib', 'libList', 'vbGenWrap', 'segVbEngine', 'vbGenHint', 'live', 'rKicker', 'rTitle', 'rVoice', 'sideOthers'];
const els = {};
for (const id of ids) els[id] = $(id);

const txt = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };
const show = (el, on) => { if (el) el.hidden = !on; };
const on = (el, ev, fn) => { if (el) el.addEventListener(ev, fn); };

// ---------- formatting ----------
const fmtRate = (r) => `${Number(r).toFixed(1).replace(/\.0$/, '')}×`;
const fmtRateLong = (r) => `${Number(r).toFixed(1)}×`;
function fmtLeft(sec) {
  sec = Math.max(0, sec || 0);
  if (sec >= 180) {
    const m = Math.round(sec / 60);
    if (m >= 60) { const h = Math.floor(m / 60), r = m % 60; return r ? `${h} hr ${String(r).padStart(2, '0')}` : `${h} hr`; }
    return `${m} min`;
  }
  const s = Math.round(sec / 10) * 10;
  if (s >= 60) { const m = Math.floor(s / 60), r = s % 60; return r ? `${m} min ${r}` : `${m} min`; }
  return `${s} sec`;
}
function fmtShort(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  if (m >= 60) { const h = Math.floor(m / 60), r = m % 60; return r ? `${h}h ${r}m` : `${h}h`; }
  return `${m}m`;
}
function fmtMins(sec) { const m = Math.max(1, Math.round(sec / 60)); return m >= 60 ? fmtLeft(sec) : `${m} min`; }
const fmtMB = (b) => Math.round(b / 1048576);
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } }
function whenPhrase(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'earlier today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'yesterday';
  if (now - d < 7 * 86400000) return `on ${d.toLocaleDateString(undefined, { weekday: 'long' })}`;
  return `on ${d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`;
}
function relWhen(ts) {
  const d = new Date(ts), now = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (d.toDateString() === now.toDateString()) return 'today';
  if (days <= 1) return 'yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const KIND_LABEL = { page: 'Web page', gdoc: 'Google Doc', gslides: 'Google Slides', pdf: 'PDF', selection: 'Selection' };
const kindLabel = (k) => KIND_LABEL[k] || 'Document';

// ---------- settings ----------
async function loadSettings() {
  const { settings, wpm } = await chrome.storage.local.get(['settings', 'wpm']);
  if (settings) Object.assign(state.settings, settings);
  // Voicebox is parked: the engine stays in the code, hidden until voiceboxEnabled is set.
  if (!state.settings.voiceboxEnabled && state.settings.engine === 'voicebox') { state.settings.engine = 'kokoro'; saveSettings(); }
  if (els.segEngine) { const b = els.segEngine.querySelector('[data-engine="voicebox"]'); if (b) b.hidden = !state.settings.voiceboxEnabled; }
  if (wpm) state.wpm = wpm;
  if (els.rate) els.rate.value = state.settings.rate;
  txt(els.rateLabel, fmtRateLong(state.settings.rate));
  if (els.followScroll) els.followScroll.checked = !!state.settings.followPanel;
  if (els.followStill) els.followStill.checked = !state.settings.followPanel;
  if (els.wordHighlight) els.wordHighlight.checked = !!state.settings.wordHighlight;
  if (els.showController) els.showController.checked = state.settings.showController !== false;
  if (els.closeQueueTabs) els.closeQueueTabs.checked = !!state.settings.closeQueueTabs;
  renderDict();
}
function saveSettings() { chrome.storage.local.set({ settings: state.settings }); }

// ---------- words per minute (measured, cached) ----------
const WPM_SEED = 180;
const WPM_MIN_SENTENCES = 30;
function wpmKey() { return `${state.settings.engine}:${currentVoice() || ''}@${Number(state.settings.rate).toFixed(1)}`; }
function currentWpm() {
  const s = state.wpm[wpmKey()];
  if (s && s.n >= WPM_MIN_SENTENCES && s.s > 0) return Math.max(60, Math.min(600, (s.w / s.s) * 60));
  return WPM_SEED * (Number(state.settings.rate) || 1);
}
let wpmSaveTimer = null;
function recordWpmSample(words, seconds) {
  if (!(seconds > 0.2) || !(words > 0)) return;
  const k = wpmKey();
  const s = state.wpm[k] || { w: 0, s: 0, n: 0 };
  s.w += words; s.s += seconds; s.n += 1;
  // Keep the window rolling so a change in the machine's load does not fossilize.
  if (s.n > 400) { s.w *= 0.5; s.s *= 0.5; s.n = 200; }
  state.wpm[k] = s;
  clearTimeout(wpmSaveTimer);
  wpmSaveTimer = setTimeout(() => chrome.storage.local.set({ wpm: state.wpm }), 2000);
}
const unitSeconds = (u) => (u.words / currentWpm()) * 60;
function secondsFrom(i) { let w = 0; for (let k = i; k < state.units.length; k++) w += state.units[k].words; return (w / currentWpm()) * 60; }
function secondsTotal() { return secondsFrom(0); }

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
function currentVoiceName() {
  const e = state.settings.engine;
  if (e === 'kokoro') return (KOKORO_VOICES.find((v) => v.id === state.settings.kokoroVoice) || KOKORO_VOICES[0]).name;
  if (e === 'voicebox') return (voiceboxVoices.find((v) => v.id === state.settings.voiceboxVoice) || { name: 'Voicebox' }).name;
  return (state.systemVoices.find((v) => v.id === state.settings.systemVoice) || { name: 'Mac voice' }).name.replace(/\s*\(.*\)$/, '');
}
function ensureVoicebox() {
  if (!voicebox) voicebox = new VoiceboxEngine({ onStatus: (s) => { if (state.settings.engine === 'voicebox') showRibbon('progress', s.message); } });
  return voicebox;
}
function voiceboxEngineFor(voiceId) { return ensureVoicebox().resolveEngine(voiceId || state.settings.voiceboxVoice, state.settings.voiceboxEngine); }
let voiceboxWarm = '';
async function warmVoicebox() {
  const v = state.settings.voiceboxVoice;
  const key = `${v}|${state.settings.voiceboxEngine}`;
  if (!v || voiceboxWarm === key) return;
  voiceboxWarm = key;
  const eng = voiceboxEngineFor(v);
  await ensureVoicebox().ensureModel(eng);
  const ok = await ensureVoicebox().warm(v, eng);
  if (state.settings.engine === 'voicebox') {
    if (ok) { if (ribbonKind === 'progress') hideRibbon(); updateEngineHint(); }
    else { voiceboxWarm = ''; notice('Voicebox answered, but generating audio failed. Check the Voicebox app: the model may still be downloading.', true); }
  }
}
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
  updateEngineHint(); renderVoiceLists(); renderNowPlaying();
}
function ensureKokoro() {
  if (kokoro) return kokoro;
  kokoro = new KokoroEngine({ onProgress: onKokoroProgress, remoteHost: state.settings.modelHost || null });
  return kokoro;
}
function onKokoroProgress(p) {
  if (p.status === 'ready') {
    kokoroLoadState = 'ready';
    kokoroProgress = null;
    if (ribbonKind === 'progress') hideRibbon();
    updateEngineHint(); renderVoiceLists(); renderNowPlaying();
    return;
  }
  if (p.status === 'fallback') return;
  if (typeof p.total === 'number' && p.total > 0) {
    kokoroProgress = { loaded: p.loaded, total: p.total };
    const pct = Math.min(100, Math.round((p.loaded / p.total) * 100));
    showRibbon('progress', pct >= 100 ? 'Preparing the voice…' : `Downloading the built-in voice · ${fmtMB(p.loaded)} of ${fmtMB(p.total)} MB`, { pct });
  }
}
let kokoroLoading = null;
function warmKokoro({ silent } = {}) {
  if (kokoroLoadState === 'ready') return Promise.resolve();
  // A load already in flight is awaited, never restarted: pressing play during
  // the download must wait on it, not spin.
  if (kokoroLoading) return kokoroLoading;
  kokoroLoadState = 'loading';
  updateEngineHint();
  kokoroLoading = (async () => {
    try {
      await ensureKokoro().ready();
      kokoroLoadState = 'ready';
      if (ribbonKind === 'progress') hideRibbon();
    } catch (e) {
      kokoroLoadState = 'failed';
      kokoro = null;
      state.settings.engine = 'system';
      saveSettings();
      if (!silent) notice(`The built-in voice could not load (${e && e.message ? e.message : e}). Using the Mac's voices for now.`, true);
    } finally { kokoroLoading = null; }
    updateEngineHint(); renderVoiceLists(); renderNowPlaying();
  })();
  return kokoroLoading;
}
function updateEngineHint() {
  const eng = state.settings.engine;
  let text = '';
  if (eng === 'kokoro') {
    text = kokoroLoadState === 'ready' ? `Neural voice running on this machine${kokoro && kokoro.device === 'webgpu' ? ', on the GPU' : ''}. Nothing you read leaves it.`
      : kokoroLoadState === 'loading' ? 'Downloading the voice model, about 320 MB, once. Reading starts when it is ready.'
      : kokoroLoadState === 'failed' ? 'The voice model failed to load. Press play to try the download again.'
      : 'One download, about 320 MB, the first time you press play. Kept on this Mac.';
  } else if (eng === 'voicebox') {
    const rtf = voicebox ? voicebox.rtf : 0;
    text = voiceboxUp === false ? 'Voicebox is not running. Open the Voicebox app on this Mac, then reopen this panel.'
      : voiceboxUp === true ? (voiceboxVoices.length
        ? `Connected to Voicebox. ${voiceboxVoices.length} voice profile${voiceboxVoices.length === 1 ? '' : 's'}, including any you cloned.${rtf ? ` Generating at ${rtf.toFixed(1)}× real time on this Mac${rtf > 1.05 ? ', slower than it plays' : ''}.` : ''}`
        : 'Connected to Voicebox, but it has no voice profiles yet. Create one in the app.')
      : 'Looking for the Voicebox app on this Mac…';
  } else {
    text = 'Voices installed on this Mac, through Chrome. Instant, and the only engine that lights up each word as it is spoken.';
  }
  txt(els.engineHint, text);
  if (els.segEngine) for (const b of els.segEngine.querySelectorAll('button')) b.classList.toggle('on', b.dataset.engine === eng);
  txt(els.voiceFoot, eng === 'system'
    ? 'Voices come from your Mac. Add Premium ones in System Settings → Accessibility → Spoken Content → System Voice, then restart Chrome.'
    : eng === 'voicebox' ? 'Voicebox has to stay open while you listen. It generates a whole sentence before it sends it, so Unabridged keeps six sentences generated ahead; the first one takes longest.'
      : 'The built-in voice is Kokoro-82M by hexgrad (Apache 2.0), an open model that runs inside Chrome. Samples play from bundled clips until the model is downloaded.');
}

// ---------- voices ----------
const langNames = (() => { try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }); } catch (_) { return null; } })();
function langLabel(code) { if (!code) return ''; try { return langNames ? langNames.of(code.replace('_', '-')) : code; } catch (_) { return code; } }
function systemQuality(v) { return /premium/i.test(v.name) ? 'Premium' : /enhanced/i.test(v.name) ? 'Enhanced' : 'System default'; }
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
function voiceRow(v, selected, sub, best) {
  const row = document.createElement('div');
  row.className = 'voice-row' + (selected ? ' selected' : '');
  row.dataset.id = v.id;
  row.setAttribute('role', 'listitem');
  row.innerHTML = `
    <button class="sample hit" data-sample="${v.id}" aria-label="Hear ${v.name}">
      <svg class="ic-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>
      <svg class="ic-stop" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"></rect></svg>
    </button>
    <button class="t" data-pick="${v.id}"><b></b><small></small></button>`;
  row.querySelector('b').textContent = v.name;
  row.querySelector('small').textContent = sub;
  if (best && selected) { const t = document.createElement('span'); t.className = 'tag tag-accent'; t.textContent = 'Best'; row.appendChild(t); }
  return row;
}
let otherLangsOpen = false;
function renderVoiceLists() {
  if (!els.voiceList) return;
  els.voiceList.innerHTML = '';
  els.voiceListOther.innerHTML = '';
  const eng = state.settings.engine;
  if (eng === 'kokoro') {
    for (const v of KOKORO_VOICES) {
      const sel = v.id === state.settings.kokoroVoice;
      els.voiceList.appendChild(voiceRow(v, sel, `${v.note}${sel ? ' · in use' : ''}`, v.grade === 'A'));
    }
    show(els.btnOtherLangs, false); show(els.voiceListOther, false);
  } else if (eng === 'voicebox') {
    for (const v of voiceboxVoices) {
      const sel = v.id === state.settings.voiceboxVoice;
      els.voiceList.appendChild(voiceRow(v, sel, `${v.note}${sel ? ' · in use' : ''}`, v.cloned));
    }
    if (!voiceboxVoices.length) { const d = document.createElement('div'); d.className = 'hint'; d.style.padding = '10px 16px'; d.textContent = voiceboxUp === false ? 'Voicebox is not running.' : voiceboxUp === null ? 'Looking for Voicebox…' : 'No voice profiles yet. Create one in the Voicebox app.'; els.voiceList.appendChild(d); }
    show(els.btnOtherLangs, false); show(els.voiceListOther, false);
  } else {
    const ui = (navigator.language || 'en').slice(0, 2).toLowerCase();
    const score = (v) => (/premium/i.test(v.name) ? 0 : /enhanced/i.test(v.name) ? 1 : 2);
    const sorted = state.systemVoices.slice().sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
    const mine = sorted.filter((v) => !v.lang || v.lang.slice(0, 2).toLowerCase() === ui);
    const others = sorted.filter((v) => !mine.includes(v));
    const selectedInOthers = others.some((v) => v.id === state.settings.systemVoice);
    for (const v of (mine.length ? mine : sorted)) {
      const sel = v.id === state.settings.systemVoice;
      els.voiceList.appendChild(voiceRow({ id: v.id, name: v.name.replace(/\s*\(.*\)$/, '') }, sel, `${systemQuality(v)} · ${langLabel(v.lang)}${sel ? ' · in use' : ''}`, score(v) === 0));
    }
    if (mine.length && others.length) {
      show(els.btnOtherLangs, true);
      txt(els.otherLangsLabel, `Other languages · ${others.length}`);
      if (selectedInOthers) otherLangsOpen = true;
      els.btnOtherLangs.classList.toggle('open', otherLangsOpen);
      els.btnOtherLangs.setAttribute('aria-expanded', String(otherLangsOpen));
      show(els.voiceListOther, otherLangsOpen);
      for (const v of others) {
        const sel = v.id === state.settings.systemVoice;
        els.voiceListOther.appendChild(voiceRow({ id: v.id, name: v.name.replace(/\s*\(.*\)$/, '') }, sel, `${systemQuality(v)} · ${langLabel(v.lang)}${sel ? ' · in use' : ''}`, score(v) === 0));
      }
    } else { show(els.btnOtherLangs, false); show(els.voiceListOther, false); }
    if (!state.systemVoices.length) notice('No Mac voices found. Download one under System Settings → Accessibility → Spoken Content → System Voice, then restart Chrome.', true);
  }
  txt(els.rVoice, currentVoiceName());
  renderVoiceboxGen();
}
function renderVoiceboxGen() {
  if (!els.vbGenWrap) return;
  const on = state.settings.engine === 'voicebox';
  show(els.vbGenWrap, on);
  if (!on) return;
  const cur = voiceboxVoices.find((v) => v.id === state.settings.voiceboxVoice);
  els.segVbEngine.innerHTML = '';
  for (const g of VOICEBOX_ENGINES) {
    const b = document.createElement('button'); b.dataset.gen = g.id; b.textContent = { auto: 'Default', chatterbox_turbo: 'Turbo', chatterbox: 'Chatterbox', qwen: 'Qwen', luxtts: 'Lux' }[g.id] || g.name; b.title = `${g.name}: ${g.note}`;
    b.classList.toggle('on', (state.settings.voiceboxEngine || 'auto') === g.id);
    els.segVbEngine.appendChild(b);
  }
  const chosen = VOICEBOX_ENGINES.find((g) => g.id === (state.settings.voiceboxEngine || 'auto')) || VOICEBOX_ENGINES[0];
  txt(els.vbGenHint, cur && !cur.cloned ? `${cur.name} is a preset voice, so it always uses its own generator. The picker applies to cloned voices.` : `${chosen.name}: ${chosen.note}. Turbo is usually the one that keeps up with playback.`);
}
function onVoiceListClick(e) {
  const sample = e.target.closest('[data-sample]');
  const pick = e.target.closest('[data-pick]');
  const eng = state.settings.engine;
  if (sample) { playSample(sample.dataset.sample, sample); return; }
  if (!pick) return;
  const id = pick.dataset.pick;
  if (eng === 'kokoro') state.settings.kokoroVoice = id; else if (eng === 'voicebox') state.settings.voiceboxVoice = id; else state.settings.systemVoice = id;
  saveSettings();
  if (eng === 'voicebox') { if (voicebox) { voicebox.flush(); voicebox.resetStats(); } voiceboxWarned = false; warmVoicebox(); }
  renderVoiceLists(); renderNowPlaying();
  if (state.playing && !state.paused) speakCurrent();
}
const SAMPLE_TEXT = 'You do not have a sales problem. You have a diagnosis problem.';
let sampleAudio = null;
let sampleBtn = null;
function stopSample() {
  if (sampleAudio) { try { sampleAudio.pause(); } catch (_) {} sampleAudio = null; }
  if (sampleBtn) { sampleBtn.classList.remove('playing'); sampleBtn = null; }
}
async function playSample(voiceId, btn) {
  const wasThis = sampleBtn === btn;
  stopSpeech(true);
  stopSample();
  if (wasThis) return;
  sampleBtn = btn; btn.classList.add('playing');
  const done = () => { if (sampleBtn === btn) { btn.classList.remove('playing'); sampleBtn = null; } };
  const unit = { spoken: SAMPLE_TEXT };
  const eng = state.settings.engine;
  if (eng === 'voicebox') { ensureVoicebox().speak(unit, { rate: state.settings.rate, voice: voiceId, engine: voiceboxEngineFor(voiceId), onEnd: done, onError: (m) => { done(); notice(m, true); } }); return; }
  if (eng === 'kokoro') {
    if (kokoroLoadState === 'ready' && kokoro) { kokoro.speak(unit, { rate: state.settings.rate, voice: voiceId, onEnd: done, onError: (m) => { done(); notice(m, true); } }); return; }
    const a = new Audio(chrome.runtime.getURL(`samples/${voiceId}.ogg`));
    a.playbackRate = Math.min(2, Math.max(0.5, Number(state.settings.rate) || 1));
    a.onended = done;
    sampleAudio = a;
    a.play().catch((e) => { done(); notice(`Could not play the sample (${e.message}).`, true); });
    return;
  }
  system.speak(unit, { rate: state.settings.rate, voice: voiceId, onEnd: done, onError: done });
}

// ---------- tabs + content script ----------
async function getTab(tabId) {
  if (typeof tabId === 'number') { try { return await chrome.tabs.get(tabId); } catch (_) {} }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) return tab;
  const [t2] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t2 || null;
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
const isInternal = (url) => /^(chrome|edge|about|chrome-extension|devtools):/i.test(url || '');

// ---------- nothing loaded: describe the active tab ----------
let describeSeq = 0;
async function describeActiveTab() {
  if (state.loaded) return;
  const seq = ++describeSeq;
  const tab = await getTab(null);
  if (!tab || seq !== describeSeq) return;
  const d = { title: tab.title || 'Open a page, doc, or PDF', kind: 'page', source: hostOf(tab.url), words: 0, internal: isInternal(tab.url), tabId: tab.id };
  state.activeTab = d;
  renderNowPlaying();
  if (d.internal) return;
  if (await ensureContentScript(tab.id)) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'ra:extract' });
      if (seq !== describeSeq) return;
      if (r && r.ok && r.blocks) {
        d.words = r.blocks.reduce((a, b) => a + (b.silent ? 0 : b.text.split(/\s+/).filter(Boolean).length), 0);
        d.kind = r.kind; d.title = r.title || d.title;
      } else if (r && r.googleExport) { d.kind = r.googleExport.kind; d.title = r.googleExport.title || d.title; }
    } catch (_) {}
  } else if (/\.pdf(?:[?#].*)?$/i.test(tab.url || '')) d.kind = 'pdf';
  if (seq === describeSeq) renderNowPlaying();
}

// ---------- loading a document ----------
async function loadFromTab(tabId, opts = {}) {
  if (state.loading) return false;
  state.loading = true;
  hideRibbon();
  try {
    const tab = await getTab(tabId);
    if (!tab) { notice('No active tab found.', true); return false; }
    if (isInternal(tab.url)) { notice('Chrome does not allow reading its own pages. Open a website, doc, or PDF.', true); return false; }
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
      showRibbon('progress', 'Reading the PDF…', { pct: null });
      doc = await loadPdf(tab.url);
      hideRibbon();
    }
    if (!doc.blocks || !doc.blocks.length) throw new Error('No readable text found on this page. Select some text and use Read the selection from the right-click menu.');
    applyDocument(tab, doc);
    await decideStart(opts);
    return true;
  } catch (e) {
    notice(e && e.message ? e.message : String(e), true);
    return false;
  } finally {
    state.loading = false;
  }
}
async function loadSelection(tabId, fallbackText) {
  hideRibbon();
  const tab = await getTab(tabId);
  if (!tab) return false;
  let text = '';
  if (await ensureContentScript(tab.id)) {
    try { const r = await chrome.tabs.sendMessage(tab.id, { type: 'ra:getSelection' }); text = (r && r.text) || ''; } catch (_) {}
  }
  if (!text.trim()) text = fallbackText || '';
  if (!text.trim()) { notice('Select some text on the page first, then use Read the selection.', true); return false; }
  const blocks = text.split(/\r?\n+/).map((t) => t.trim()).filter(Boolean).map((t) => ({ text: t, heading: false }));
  applyDocument(tab, { kind: 'selection', title: `Selection from ${tab.title || 'page'}`, canHighlight: false, blocks, gen: 0 }, { noMemory: true });
  state.idx = 0;
  play();
  return true;
}
function applyDocument(tab, doc, o = {}) {
  stopSpeech();
  state.loaded = true;
  state.tabId = tab.id; state.windowId = tab.windowId; state.url = tab.url || '';
  state.key = o.noMemory ? '' : positionKey(state.url);
  state.gen = doc.gen || 0; state.kind = doc.kind; state.title = doc.title || tab.title || '';
  state.source = doc.kind === 'pdf' ? (doc.pages ? `${doc.pages} page${doc.pages === 1 ? '' : 's'}` : '') : doc.kind === 'page' || doc.kind === 'selection' ? hostOf(state.url) : '';
  state.pages = doc.pages || 0;
  state.canHighlight = !!doc.canHighlight; state.staleNoticed = false;
  state.blocks = doc.blocks; state.idx = 0; state.wordRange = null; state.resumedFrom = null;
  state.followSuspended = false;
  buildUnits();
  buildChapters();
  renderTranscript();
  setPanelView('reading');
  renderNowPlaying();
  showView('reading');
  claimPlayback();
}
function buildUnits() {
  const rules = state.settings.pronunciations || [];
  state.units = [];
  state.blocks.forEach((b, bi) => {
    if (b.silent) return;
    for (const s of splitSentences(b.text)) {
      const raw = b.text.slice(s.start, s.end);
      const sp = prepareSpoken(raw, rules);
      if (!sp.text) continue;
      state.units.push({ b: bi, start: s.start, end: s.end, spoken: sp.text, map: sp.map, words: sp.text.split(/\s+/).length });
    }
  });
}
function rebuildUnitsInPlace() {
  if (!state.blocks.length) return;
  const cur = state.units[state.idx];
  const wasPlaying = state.playing && !state.paused;
  stopSpeech(true);
  buildUnits(); buildChapters();
  if (cur) {
    const i = state.units.findIndex((u) => u.b === cur.b && u.start === cur.start);
    state.idx = i >= 0 ? i : Math.min(state.idx, state.units.length - 1);
  }
  renderTranscript();
  markCurrent();
  if (wasPlaying) play();
}

// Chapters: units grouped between headings. PDFs: one chapter per page.
// An H1 that repeats the document title is not a boundary, and a short
// preamble (kicker, byline) folds into the first real chapter.
const PREAMBLE_MAX_WORDS = 40;
function buildChapters() {
  const norm = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase();
  const title = norm(state.title || '');
  const isTitleHeading = (b) => b.level === 1 && title && (title === norm(b.text) || title.startsWith(norm(b.text)) || norm(b.text).startsWith(title));
  const ch = [];
  let cur = null;
  let ui = 0;
  const open = (t) => { cur = { title: t.replace(/\s+/g, ' ').trim(), startUnit: ui, endUnit: ui, words: 0 }; ch.push(cur); };
  state.blocks.forEach((b, bi) => {
    if (b.silent) { const m = /^Page (\d+) of \d+$/.exec(b.text); if (m) { if (cur && cur.endUnit === cur.startUnit) ch.pop(); open(`Page ${m[1]}`); } return; }
    if (b.heading && state.kind !== 'pdf' && !isTitleHeading(b)) {
      if (cur && cur.endUnit === cur.startUnit) cur.title = b.text.replace(/\s+/g, ' ').trim();
      else if (cur && ch.length === 1 && !cur.fromHeading && cur.words < PREAMBLE_MAX_WORDS) { cur.title = b.text.replace(/\s+/g, ' ').trim(); cur.fromHeading = true; }
      else { open(b.text); cur.fromHeading = true; }
    }
    while (ui < state.units.length && state.units[ui].b === bi) {
      if (!cur) open(state.title || 'Start');
      cur.words += state.units[ui].words; ui += 1; cur.endUnit = ui;
    }
  });
  const kept = ch.filter((c) => c.endUnit > c.startUnit);
  if (!kept.length && state.units.length) kept.push({ title: state.title || 'Start', startUnit: 0, endUnit: state.units.length, words: state.units.reduce((a, u) => a + u.words, 0) });
  state.chapters = kept;
  state.chapterIdx = chapterOf(state.idx);
  renderStrip(true);
}
function chapterOf(idx) { const i = state.chapters.findIndex((c) => idx >= c.startUnit && idx < c.endUnit); return i < 0 ? 0 : i; }
const chapterSeconds = (c) => (c.words / currentWpm()) * 60;

async function decideStart(opts) {
  if (typeof opts.blockIndex === 'number') {
    const i = state.units.findIndex((u) => u.b >= opts.blockIndex);
    state.idx = i >= 0 ? i : 0;
    play();
    return;
  }
  const saved = state.key ? await readPosition(state.key) : null;
  if (saved && !saved.done && saved.idx > 0 && saved.idx < state.units.length - 1) {
    state.idx = Math.min(saved.idx, state.units.length - 1);
    state.resumedFrom = saved.ts || Date.now();
    showRibbon('resume', `Picked up where you stopped ${whenPhrase(state.resumedFrom)}.`, { action: 'Start over' });
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
  // Heuristic headings: short lines without terminal punctuation, followed by longer text.
  const blocks = lines.map((t, i) => ({ text: t, heading: t.length < 80 && !/[.!?:;,]$/.test(t) && lines[i + 1] && lines[i + 1].length > 80 }));
  return { kind: info.kind, title: info.title, canHighlight: false, blocks, gen: 0 };
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
  if (!isPdf) throw new Error('This page cannot be read directly (no content script access and not a PDF). Select some text and use Read the selection.');
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
    if (p % 10 === 0) showRibbon('progress', `Reading the PDF · page ${p} of ${pdf.numPages}`, { pct: Math.round((p / pdf.numPages) * 100) });
  }
  if (!title || /^\(anonymous\)$/i.test(title)) title = decodeURIComponent(url.split('/').pop().split('?')[0]);
  return { kind: 'pdf', title, canHighlight: false, blocks, gen: 0, pages: pdf.numPages };
}

// ---------- transcript ----------
function renderTranscript() {
  const t = els.transcript;
  if (!t) return;
  t.innerHTML = '';
  const frag = document.createDocumentFragment();
  let host = frag;
  if (SURFACE === 'reader') {
    const col = document.createElement('div'); col.className = 'col';
    const k = document.createElement('div'); k.className = 'r-kicker'; k.id = 'rKicker'; col.appendChild(k);
    const h = document.createElement('h1'); h.className = 'r-title'; h.id = 'rTitle'; h.textContent = state.title; col.appendChild(h);
    frag.appendChild(col); host = col;
    els.rKicker = k; els.rTitle = h;
  }
  let unitIdx = 0;
  state.blocks.forEach((b, bi) => {
    const p = document.createElement('p');
    if (b.silent) { p.className = 'silent'; p.textContent = b.text; host.appendChild(p); return; }
    if (b.heading && state.kind !== 'pdf') p.className = 'h';
    host.appendChild(p);
    let any = false;
    while (unitIdx < state.units.length && state.units[unitIdx].b === bi) {
      const u = state.units[unitIdx];
      const span = document.createElement('span');
      span.className = 's';
      span.dataset.i = String(unitIdx);
      span.tabIndex = -1;
      span.textContent = b.text.slice(u.start, u.end);
      p.appendChild(span);
      p.appendChild(document.createTextNode(' '));
      u.el = span;
      unitIdx++;
      any = true;
    }
    if (!any) p.textContent = b.text.replace(/\s+/g, ' ').trim();
  });
  t.appendChild(frag);
  t.scrollTop = 0;
  show(els.btnJump, false);
}
on(els.transcript, 'click', (e) => {
  const s = e.target.closest('.s');
  if (!s) return;
  state.idx = Number(s.dataset.i);
  state.followSuspended = false;
  seekFlush();
  play();
});
on(els.transcript, 'keydown', (e) => {
  const s = e.target.closest && e.target.closest('.s');
  if (!s) return;
  if (e.key === 'Enter') { e.preventDefault(); state.idx = Number(s.dataset.i); state.followSuspended = false; seekFlush(); play(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const i = Number(s.dataset.i) + (e.key === 'ArrowDown' ? 1 : -1);
    const u = state.units[i]; if (u && u.el) { e.preventDefault(); u.el.focus(); }
  }
});

// Word karaoke: wrap only the current word, unwrap before wrapping the next.
let wordSpan = null;
function clearWord() {
  if (wordSpan && wordSpan.parentNode) {
    const s = wordSpan.parentNode;
    const raw = s.dataset.raw;
    if (raw !== undefined) s.textContent = raw;
  }
  wordSpan = null;
}
function setWord(u, range) {
  clearWord();
  if (!u || !u.el || !range) return;
  const s = u.el;
  const raw = s.dataset.raw !== undefined ? s.dataset.raw : (s.dataset.raw = s.textContent);
  const a = Math.max(0, range.start - u.start), b = Math.min(raw.length, range.end - u.start);
  if (b <= a) return;
  s.textContent = '';
  s.appendChild(document.createTextNode(raw.slice(0, a)));
  const w = document.createElement('span'); w.className = 'w'; w.textContent = raw.slice(a, b);
  s.appendChild(w);
  s.appendChild(document.createTextNode(raw.slice(b)));
  wordSpan = w;
}

let liveTimer = 0;
function markCurrent() {
  clearWord();
  const t = els.transcript;
  if (t) {
    const cur = t.querySelector('.s.current');
    if (cur) { cur.classList.remove('current', 'paused'); cur.classList.add('read'); }
    for (const r of t.querySelectorAll('.s.read')) { const i = Number(r.dataset.i); if (i >= state.idx) r.classList.remove('read'); }
  }
  const u = state.units[state.idx];
  if (u && u.el) {
    u.el.classList.add('current'); u.el.classList.remove('read');
    u.el.classList.toggle('paused', state.paused || !state.playing);
    // Everything before the current sentence reads as read, even after a seek backward.
    for (let i = 0; i < state.idx; i++) { const e = state.units[i].el; if (e && !e.classList.contains('read')) e.classList.add('read'); }
    followCurrent();
    if (state.settings.followPanel && !state.followSuspended && els.live) {
      const now = Date.now();
      if (now - liveTimer > 1500) { liveTimer = now; els.live.textContent = u.el.textContent; }
    }
  }
  state.chapterIdx = chapterOf(state.idx);
  renderNowPlaying();
}
let programmaticScrollUntil = 0;
function followCurrent(force) {
  const t = els.transcript, u = state.units[state.idx];
  if (!t || !u || !u.el) return;
  if (!force && (!state.settings.followPanel || state.followSuspended)) return;
  const box = t.getBoundingClientRect();
  const r = u.el.getBoundingClientRect();
  const top = r.top - box.top + t.scrollTop;
  const h = t.clientHeight;
  const inMiddle = r.top >= box.top + h / 3 && r.bottom <= box.top + (2 * h) / 3;
  if (inMiddle && !force) return;
  const target = Math.max(0, top - h / 3);
  programmaticScrollUntil = Date.now() + 600;
  t.scrollTo({ top: target, behavior: 'smooth' });
}
on(els.transcript, 'scroll', () => {
  if (Date.now() < programmaticScrollUntil) return;
  if (!state.settings.followPanel || !state.units.length) return;
  if (!state.followSuspended) { state.followSuspended = true; show(els.btnJump, true); }
});
on(els.btnJump, 'click', () => { state.followSuspended = false; show(els.btnJump, false); followCurrent(true); });

// ---------- now-playing block ----------
const RING_C = 270.2;
function renderNowPlaying() {
  const loaded = state.loaded && state.units.length > 0;
  const total = state.units.length;
  const playState = state.waiting ? 'waiting' : state.playing && !state.paused ? 'playing' : state.paused ? 'paused' : 'stopped';
  if (els.btnPlay) {
    els.btnPlay.dataset.state = playState;
    els.btnPlay.setAttribute('aria-label', playState === 'playing' ? 'Pause' : playState === 'waiting' ? 'Preparing the voice' : loaded ? 'Play' : 'Read this page');
    els.btnPlay.setAttribute('aria-pressed', String(playState === 'playing'));
  }
  if (els.ring) els.ring.classList.toggle('paused', playState === 'paused');
  const compact = state.panelView !== 'reading' && SURFACE === 'panel' && loaded;
  if (els.np) els.np.classList.toggle('compact', compact);
  show(els.btnNpClose, compact);
  const voice = currentVoiceName();
  const rate = fmtRate(state.settings.rate);
  if (!loaded) {
    const d = state.activeTab;
    const frac = 0;
    if (els.ringFill) els.ringFill.style.strokeDashoffset = String(RING_C * (1 - frac));
    txt(els.npKicker, d ? (d.internal ? 'Cannot read this page' : `${kindLabel(d.kind)}${d.source ? ` · ${d.source}` : ''}`) : 'Nothing playing');
    txt(els.npTitle, d ? d.title : '');
    if (d && d.words) { txt(els.npMin, fmtLeft((d.words / currentWpm()) * 60)); txt(els.npSub, `at ${rate} · ${voice}`); }
    else { txt(els.npMin, ''); txt(els.npSub, d && !d.internal ? `Press play to read this page · ${rate} · ${voice}` : ''); }
    if (els.strip) els.strip.innerHTML = '';
    txt(els.capLeft, ''); txt(els.capRight, '');
    if (els.btnPrev) els.btnPrev.disabled = true;
    if (els.btnNext) els.btnNext.disabled = true;
    if (els.chipContents) els.chipContents.disabled = true;
    return;
  }
  if (els.btnPrev) els.btnPrev.disabled = false;
  if (els.btnNext) els.btnNext.disabled = false;
  if (els.chipContents) els.chipContents.disabled = false;
  const frac = total ? state.idx / total : 0;
  if (els.ringFill) els.ringFill.style.strokeDashoffset = String((RING_C * (1 - frac)).toFixed(1));
  const kind = kindLabel(state.kind);
  if (compact) {
    txt(els.npKicker, state.panelView === 'contents' ? `Contents · ${state.chapters.length} section${state.chapters.length === 1 ? '' : 's'}` : state.panelView === 'voice' ? 'Voice' : 'Still reading');
  } else {
    txt(els.npKicker, `${playState === 'paused' || playState === 'stopped' ? 'Paused · ' : ''}${kind}${state.source ? ` · ${state.source}` : ''}`);
  }
  txt(els.npTitle, state.title);
  if (els.npTitle) els.npTitle.title = state.title;
  const left = secondsFrom(state.idx);
  txt(els.npMin, fmtLeft(left));
  let sub = `left · ${rate} · ${voice}`;
  if (state.sleep.mode === 'minutes') { const m = Math.max(0, Math.ceil((state.sleep.until - Date.now()) / 60000)); sub += ` · stops in ${m} min`; }
  else if (state.sleep.mode === 'section') sub += ' · stops at section end';
  txt(els.npSub, sub);
  if (SURFACE === 'reader') {
    txt(els.rKicker, `${kind}${state.source ? ` · ${state.source}` : ''} · ${fmtMins(secondsTotal())} total`);
    txt(els.rTitle, state.title);
    txt(els.rVoice, voice);
    const rk = $('rMinKicker'); txt(rk, `left · ${rate}`);
  }
  renderStrip(false);
  const ci = state.chapterIdx, c = state.chapters[ci];
  if (state.chapters.length > 1 && c) txt(els.capLeft, `${ci + 1} of ${state.chapters.length} · ${c.title}`);
  else txt(els.capLeft, '');
  txt(els.capRight, SURFACE === 'reader' ? `sentence ${state.idx + 1} of ${total}` : `${state.idx + 1} / ${total}`);
  if (state.panelView === 'contents' || SURFACE === 'reader') renderToc();
}
function renderStrip(rebuild) {
  const strip = els.strip;
  if (!strip) return;
  if (rebuild || strip.childElementCount !== state.chapters.length) {
    strip.innerHTML = '';
    state.chapters.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'seg-ch';
      b.dataset.i = String(i);
      b.setAttribute('role', 'listitem');
      b.style.flex = String(Math.max(1, Math.round(chapterSeconds(c))));
      const inner = document.createElement('div'); inner.className = 'inner'; b.appendChild(inner);
      strip.appendChild(b);
    });
  }
  const ci = state.chapterIdx;
  state.chapters.forEach((c, i) => {
    const b = strip.children[i];
    if (!b) return;
    const secs = chapterSeconds(c);
    b.classList.toggle('past', i < ci);
    b.classList.toggle('current', i === ci);
    b.classList.toggle('future', i > ci);
    const label = `${state.chapters.length > 1 ? `Chapter ${i + 1}, ` : ''}${c.title}, ${fmtMins(secs)}`;
    b.setAttribute('aria-label', label);
    b.title = label;
    if (i === ci) {
      const inChapter = c.endUnit - c.startUnit;
      const done = state.idx - c.startUnit;
      b.querySelector('.inner').style.width = `${inChapter ? Math.round((done / inChapter) * 100) : 0}%`;
    }
  });
}
on(els.strip, 'click', (e) => {
  const b = e.target.closest('.seg-ch');
  if (!b) return;
  seekChapter(Number(b.dataset.i));
});
function seekChapter(i) {
  const c = state.chapters[i];
  if (!c) return;
  state.idx = c.startUnit;
  state.followSuspended = false;
  seekFlush();
  if (state.playing) { state.paused = false; speakCurrent(); } else { markCurrent(); savePosition(); }
}

// ---------- contents ----------
function renderToc() {
  const toc = els.toc;
  if (!toc) return;
  toc.innerHTML = '';
  const ci = state.chapterIdx;
  const c = state.chapters[ci];
  const leftInChapter = c ? secondsFrom(state.idx) - secondsFrom(c.endUnit) : 0;
  state.chapters.forEach((ch, i) => {
    const row = document.createElement('button');
    row.className = 'toc-row' + (i < ci ? ' read' : i === ci ? ' current' : '');
    row.setAttribute('role', 'listitem');
    row.dataset.i = String(i);
    const secs = chapterSeconds(ch);
    row.innerHTML = `<span class="n num"></span><span class="t"></span><span class="d num"></span>
      <svg class="play" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>`;
    row.querySelector('.n').textContent = String(i + 1);
    const t = row.querySelector('.t');
    t.textContent = ch.title;
    if (i === ci) {
      const small = document.createElement('small');
      small.textContent = `now reading · ${fmtMins(Math.max(0, leftInChapter))} left of ${fmtMins(secs).replace(' min', '')}`;
      t.appendChild(small);
    }
    row.querySelector('.d').textContent = SURFACE === 'reader' ? fmtShort(secs) : fmtMins(secs);
    row.setAttribute('aria-label', `${i === ci ? 'Now reading, ' : ''}chapter ${i + 1}, ${ch.title}, ${fmtMins(secs)}`);
    toc.appendChild(row);
  });
  if (els.btnLibrary) countOthers().then((n) => { txt(els.btnLibrary, n ? `Still reading · ${n} other${n === 1 ? '' : 's'}` : 'Still reading'); txt(els.sideOthers, n ? `Still reading · ${n} other${n === 1 ? '' : 's'}` : 'Still reading'); });
}
on(els.toc, 'click', (e) => {
  const row = e.target.closest('.toc-row');
  if (!row) return;
  seekChapter(Number(row.dataset.i));
  if (SURFACE === 'panel') setPanelView('reading');
  if (!state.playing) play();
});

// ---------- playback ----------
const SKIP_BACK_AFTER_MS = 30000;
function play() {
  if (!state.units.length) { loadFromTab(state.activeTab ? state.activeTab.tabId : null, {}); return; }
  if (state.idx >= state.units.length) state.idx = 0;
  state.playing = true;
  state.followSuspended = false; show(els.btnJump, false);
  if (state.sleep.mode === 'minutes' && state.sleep.until <= Date.now()) setSleep('off');
  if (state.paused) {
    if (Date.now() - state.pausedAt > SKIP_BACK_AFTER_MS) {
      stopSpeech(true);
      state.playing = true;
      state.idx = Math.max(0, state.idx - 1);
      speakCurrent();
      return;
    }
    state.paused = false; currentEngine().resume(); markCurrent(); pushStatus(); return;
  }
  speakCurrent();
}
function pause() {
  if (!state.playing || state.paused) return;
  state.paused = true;
  state.pausedAt = Date.now();
  currentEngine().pause();
  clearWord();
  markCurrent();
  pushStatus();
}
function togglePlay() {
  if (!state.units.length) { play(); return; }
  if (state.playing && !state.paused) pause();
  else play();
}
function stopSpeech(keepUI) {
  state.playing = false; state.paused = false; state.waiting = false;
  try { system.stop(); } catch (_) {}
  try { if (kokoro) kokoro.stop(); } catch (_) {}
  try { if (voicebox) voicebox.stop(); } catch (_) {}
  clearWord();
  if (!keepUI) renderNowPlaying();
}
function stop() { stopSpeech(); clearPageHighlight(); state.queueMode = false; markCurrent(); savePosition(); }

let speakSeq = 0;
let unitStartedAt = 0;
async function speakCurrent() {
  const u = state.units[state.idx];
  if (!u) { finish(); return; }
  const my = ++speakSeq;
  const engine = currentEngine();
  if (state.paused) { state.paused = false; engine.resume(); }
  state.wordRange = null;
  markCurrent();
  pageHighlight(u, null);
  savePosition();
  state.waiting = engine.kind !== 'system';
  renderNowPlaying();
  if (engine.kind === 'kokoro' && kokoroLoadState !== 'ready') {
    try { await warmKokoro(); } catch (_) {}
    if (my !== speakSeq) return;
    if (kokoroLoadState !== 'ready') { state.waiting = false; setTimeout(() => { if (my === speakSeq) speakCurrent(); }, 250); return; }
  }
  let vbEngine = null;
  if (engine.kind === 'voicebox') {
    if (!currentVoice()) {
      await refreshVoicebox();
      if (my !== speakSeq) return;
      if (!currentVoice()) { stopSpeech(); notice(voiceboxUp ? 'Voicebox has no voice profiles yet. Create one in the Voicebox app, then press play.' : 'Voicebox is not running. Open the Voicebox app on this Mac, then press play.', true); return; }
    }
    vbEngine = voiceboxEngineFor(currentVoice());
    await engine.ensureModel(vbEngine);
    if (my !== speakSeq) return;
    startVoiceboxWait(my);
  }
  const eng = currentEngine();
  const opts = {
    rate: Number(state.settings.rate) || 1,
    voice: currentVoice(),
    engine: vbEngine,
    onStart: () => {
      if (my !== speakSeq) return;
      state.waiting = false; state.errors = 0; unitStartedAt = performance.now();
      stopVoiceboxWait();
      if (eng.kind === 'voicebox' && eng.stats.n >= 3 && eng.rtf > 1.05 && !voiceboxWarned) {
        voiceboxWarned = true;
        showRibbon('info', `Voicebox is generating at ${eng.rtf.toFixed(1)}× real time on this Mac, slower than it plays, so pauses between sentences will happen. ${state.settings.voiceboxEngine === 'chatterbox_turbo' ? 'A shorter document or the built-in voice will read without gaps.' : 'Chatterbox Turbo under Voice is faster.'}`);
      }
      renderNowPlaying(); pushStatus(); prefetchAhead();
    },
    onWord: (ci, len) => {
      if (my !== speakSeq || state.paused) return;
      const r = wordRange(u, ci, len);
      state.wordRange = r ? { unitIdx: state.idx, start: r.start, end: r.end } : null;
      setWord(u, r);
      if (state.settings.wordHighlight) pageHighlight(u, r);
    },
    onEnd: () => {
      if (my !== speakSeq || !state.playing || state.paused) return;
      if (unitStartedAt) recordWpmSample(u.words, (performance.now() - unitStartedAt) / 1000);
      unitStartedAt = 0;
      if (state.idx < state.units.length - 1) {
        const next = state.units[state.idx + 1];
        if (sleepShouldStop(next)) { state.idx += 1; stopForSleep(); return; }
        state.idx += 1; speakCurrent();
      } else finish();
    },
    onError: (msg) => {
      if (my !== speakSeq) return;
      state.waiting = false;
      state.errors += 1;
      if (state.errors >= 3) { stopSpeech(); notice(`The voice failed three times in a row (${msg}). Try another voice or engine under Voice.`, true); return; }
      notice(`Voice error: ${msg}. Skipping ahead.`, true);
      if (state.playing && state.idx < state.units.length - 1) { state.idx += 1; setTimeout(() => { if (my === speakSeq) speakCurrent(); }, 300); }
    }
  };
  eng.speak(u, opts);
}
function prefetchAhead() {
  const engine = currentEngine();
  if (engine.kind === 'system') return;
  const depth = engine.lookahead || 3;
  engine.prefetch(state.units.slice(state.idx + 1, state.idx + 1 + depth), { rate: state.settings.rate, voice: currentVoice(), engine: engine.kind === 'voicebox' ? voiceboxEngineFor(currentVoice()) : undefined });
}
// While Voicebox generates the sentence we are waiting on, say so after two seconds.
let vbWaitTimer = null;
let vbWaitStart = 0;
function startVoiceboxWait(my) {
  stopVoiceboxWait();
  vbWaitStart = Date.now();
  vbWaitTimer = setInterval(() => {
    if (my !== speakSeq || !state.waiting) { stopVoiceboxWait(); return; }
    const secs = Math.round((Date.now() - vbWaitStart) / 1000);
    if (secs < 2 || !voicebox) return;
    const ahead = state.units.slice(state.idx + 1, state.idx + 1 + (voicebox.lookahead || 6));
    const ready = voicebox.buffered(ahead, currentVoice(), voiceboxEngineFor(currentVoice()));
    showRibbon('progress', `Voicebox is generating this sentence… ${secs}s · ${ready} of ${ahead.length} ahead ready`);
  }, 1000);
}
function stopVoiceboxWait() { if (vbWaitTimer) { clearInterval(vbWaitTimer); vbWaitTimer = null; } if (ribbonKind === 'progress') hideRibbon(); }
// A seek throws away queued Voicebox work that is no longer ahead of the reader.
function seekFlush() { if (voicebox && state.settings.engine === 'voicebox') voicebox.flush(); }
function finish() {
  state.playing = false; state.paused = false; state.waiting = false;
  clearPageHighlight();
  state.idx = state.units.length;
  if (state.key) savePosition({ done: true });
  state.resumedFrom = null;
  markCurrent();
  pushStatus();
  if (state.queueMode && state.queueCurrentId) { finishQueueItem(true); return; }
  showRibbon('info', 'Finished. Press play to hear it again from the top.', { action: 'Start over' });
}
function wordRange(u, charIndex, length) {
  if (charIndex < 0 || charIndex >= u.map.length) return null;
  let len = typeof length === 'number' && length > 0 ? length : 0;
  if (!len) { let k = charIndex; while (k < u.spoken.length && !/\s/.test(u.spoken[k])) k++; len = k - charIndex; }
  const endIdx = Math.min(charIndex + len - 1, u.map.length - 1);
  return { start: u.start + u.map[charIndex], end: u.start + u.map[endIdx] + 1 };
}
function step(delta) {
  if (!state.units.length) return;
  state.idx = Math.max(0, Math.min(state.units.length - 1, state.idx + delta));
  state.followSuspended = false;
  if (delta < 0) seekFlush();
  if (state.playing) { state.paused = false; speakCurrent(); }
  else { markCurrent(); savePosition(); }
}

// ---------- page highlight + floating controller ----------
let lastHighlightKey = '';
function statusPayload() {
  const total = state.units.length;
  return {
    show: state.settings.showController !== false && state.loaded,
    playing: state.playing && !state.paused,
    waiting: state.waiting,
    left: state.loaded ? fmtLeft(secondsFrom(state.idx)) : '',
    fraction: total ? state.idx / total : 0
  };
}
async function pageHighlight(u, word) {
  if (!state.canHighlight || state.tabId === null) return;
  const key = `${state.idx}:${word ? word.start : ''}`;
  if (key === lastHighlightKey) return;
  lastHighlightKey = key;
  try {
    const r = await chrome.tabs.sendMessage(state.tabId, { type: 'ra:highlight', gen: state.gen, blockIndex: u.b, start: u.start, end: u.end, word, status: statusPayload() });
    if (r && r.stale && !state.staleNoticed) {
      state.staleNoticed = true; state.canHighlight = false;
      notice('The page changed since it was loaded, so on-page highlighting is off. The transcript here still follows along.');
    }
  } catch (_) { state.canHighlight = false; }
}
function pushStatus() {
  if (state.tabId === null) return;
  chrome.tabs.sendMessage(state.tabId, { type: 'ra:status', status: statusPayload() }).catch(() => {});
}
function clearPageHighlight() {
  lastHighlightKey = '';
  if (state.tabId === null) return;
  chrome.tabs.sendMessage(state.tabId, { type: 'ra:clear' }).catch(() => {});
}

// ---------- sleep timer ----------
function setSleep(mode, minutes) {
  if (mode === 'minutes') state.sleep = { mode, until: Date.now() + minutes * 60000, minutes };
  else state.sleep = { mode, until: 0 };
  renderSleepUI();
  renderNowPlaying();
}
function sleepShouldStop(nextUnit) {
  const s = state.sleep;
  if (s.mode === 'minutes') return Date.now() >= s.until;
  if (s.mode === 'section') return chapterOf(state.idx + 1) !== chapterOf(state.idx) && !!nextUnit;
  return false;
}
function stopForSleep() {
  const why = state.sleep.mode === 'section' ? 'Stopped at the end of the section.' : `Stopped after ${state.sleep.minutes} minutes.`;
  state.playing = false; state.paused = false; state.waiting = false;
  try { currentEngine().stop(); } catch (_) {}
  setSleep('off');
  markCurrent();
  savePosition();
  clearPageHighlight();
  pushStatus();
  showRibbon('info', `${why} Press play to continue from here.`);
}
function renderSleepUI() {
  if (!els.segSleep) return;
  for (const b of els.segSleep.querySelectorAll('button')) {
    const isOn = b.dataset.sleep === state.sleep.mode && (state.sleep.mode !== 'minutes' || Number(b.dataset.min) === state.sleep.minutes);
    b.classList.toggle('on', isOn);
  }
}

// ---------- position memory (local, mirrored to Chrome sync) ----------
function hashKey(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
let saveTimer = null;
let syncTimer = null;
function positionRecord(extra) {
  const total = state.units.length;
  let wordsLeft = 0; for (let i = state.idx; i < total; i++) wordsLeft += state.units[i].words;
  const wordsTotal = state.units.reduce((a, u) => a + u.words, 0);
  return { idx: state.idx, total, title: state.title, kind: state.kind, source: state.source, wordsLeft, wordsTotal, page: state.kind === 'pdf' ? Number((state.chapters[state.chapterIdx] || { title: '' }).title.replace(/\D/g, '')) || 0 : 0, pages: state.pages, ts: Date.now(), done: false, ...(extra || {}) };
}
function savePosition(extra) {
  if (!state.key) return;
  clearTimeout(saveTimer);
  const rec = positionRecord(extra);
  const write = () => chrome.storage.local.set({ [state.key]: rec });
  if (extra) write(); else saveTimer = setTimeout(write, 500);
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    try { chrome.storage.sync.set({ ['sp:' + hashKey(state.key)]: { k: state.key, idx: rec.idx, total: rec.total, title: rec.title, kind: rec.kind, ts: rec.ts, done: rec.done } }).catch(() => {}); } catch (_) {}
  }, 5000);
}
async function readPosition(key) {
  const local = (await chrome.storage.local.get(key))[key] || null;
  let remote = null;
  try { remote = (await chrome.storage.sync.get('sp:' + hashKey(key)))['sp:' + hashKey(key)] || null; } catch (_) {}
  if (remote && (!local || remote.ts > local.ts)) return remote;
  return local;
}
async function prunePositions() {
  const all = await chrome.storage.local.get(null);
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  const stale = Object.keys(all).filter((k) => k.startsWith('pos:') && all[k] && all[k].ts < cutoff);
  if (stale.length) chrome.storage.local.remove(stale);
  try {
    const all2 = await chrome.storage.sync.get(null);
    const keys = Object.keys(all2).filter((k) => k.startsWith('sp:')).sort((a, b) => (all2[b].ts || 0) - (all2[a].ts || 0));
    const drop = keys.filter((k, i) => i >= 120 || (all2[k].ts || 0) < cutoff);
    if (drop.length) chrome.storage.sync.remove(drop);
  } catch (_) {}
}
async function listPositions() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).filter(([k, v]) => k.startsWith('pos:') && v && typeof v.idx === 'number').map(([k, v]) => ({ key: k, url: k.slice(4), ...v })).sort((a, b) => b.ts - a.ts);
}
async function countOthers() {
  const items = await listPositions();
  return items.filter((it) => !it.done && it.key !== state.key && it.idx > 0).length + state.queue.length;
}

// ---------- library ----------
async function renderLibrary() {
  const list = els.libList;
  if (!list) return;
  if (els.segLib) for (const b of els.segLib.querySelectorAll('button')) b.classList.toggle('on', b.dataset.f === state.libFilter);
  const items = await listPositions();
  list.innerHTML = '';
  const f = state.libFilter;
  const shown = items.filter((it) => f === 'all' ? true : f === 'finished' ? it.done : !it.done && (it.idx > 0 || it.key === state.key));
  const wpm = currentWpm();
  if (f !== 'finished' && state.queue.length) {
    const sub = document.createElement('div'); sub.className = 'sub';
    sub.innerHTML = `<span>Up next · ${state.queue.length}</span>`;
    const pa = document.createElement('button'); pa.className = 'link'; pa.textContent = 'Play all'; pa.addEventListener('click', () => startQueue(0)); sub.appendChild(pa);
    list.appendChild(sub);
    state.queue.forEach((q, i) => {
      const row = document.createElement('div');
      row.className = 'lrow' + (q.id === state.queueCurrentId ? ' active' : '');
      row.innerHTML = `${miniRing(0)}<div class="t"><b></b><small></small></div><button class="go hit" aria-label="Play from here"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg></button><button class="x hit" aria-label="Remove from the queue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button>`;
      row.querySelector('b').textContent = q.title || q.url;
      row.querySelector('small').textContent = `Queued · ${hostOf(q.url)}`;
      row.querySelector('.go').addEventListener('click', () => startQueue(i));
      row.querySelector('.x').addEventListener('click', async () => { state.queue.splice(i, 1); await saveQueue(); renderLibrary(); });
      list.appendChild(row);
    });
    if (shown.length) { const sub2 = document.createElement('div'); sub2.className = 'sub'; sub2.innerHTML = '<span>Stopped partway</span>'; list.appendChild(sub2); }
  }
  if (!shown.length && !(f !== 'finished' && state.queue.length)) {
    const e = document.createElement('div'); e.className = 'lib-empty';
    e.textContent = f === 'finished' ? 'Nothing finished yet. Documents you read to the end collect here.' : 'Nothing stopped partway. Start reading anything and your place is kept here for 90 days.';
    list.appendChild(e);
  }
  for (const it of shown) {
    const active = it.key === state.key && state.loaded;
    const frac = it.total ? Math.min(1, (it.done ? it.total : it.idx) / it.total) : 0;
    const secsLeft = it.done ? 0 : ((it.wordsLeft || 0) / wpm) * 60;
    const row = document.createElement('div');
    row.className = 'lrow' + (active ? ' active' : '');
    row.innerHTML = `${miniRing(frac)}<div class="t"><b></b><small></small></div><button class="go hit" aria-label="Resume"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg></button>`;
    row.querySelector('b').textContent = it.title || it.url;
    const bits = [];
    if (it.kind === 'pdf' && it.page) bits.push(`PDF, page ${it.page}${it.pages ? ` of ${it.pages}` : ''}`);
    else bits.push(it.source || kindLabel(it.kind));
    if (it.done) bits.push('finished');
    else if (it.wordsLeft !== undefined) bits.push(`${fmtLeft(secsLeft)} left`);
    else bits.push(`sentence ${it.idx + 1} of ${it.total}`);
    bits.push(active ? 'open in this tab' : relWhen(it.ts));
    row.querySelector('small').textContent = bits.join(' · ');
    row.querySelector('.go').addEventListener('click', () => { if (active) { if (SURFACE === 'panel') setPanelView('reading'); play(); } else openAndRead(it.url); });
    list.appendChild(row);
  }
}
function miniRing(frac) {
  const C = 119.4;
  return `<div class="mini" aria-hidden="true"><svg viewBox="0 0 44 44"><circle class="track" cx="22" cy="22" r="19"></circle><circle class="fill" cx="22" cy="22" r="19" stroke-dasharray="${C}" stroke-dashoffset="${(C * (1 - frac)).toFixed(1)}"></circle></svg><span class="pct">${Math.round(frac * 100)}%</span></div>`;
}
on(els.segLib, 'click', (e) => { const b = e.target.closest('button[data-f]'); if (!b) return; state.libFilter = b.dataset.f; renderLibrary(); });
async function openAndRead(url) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  let tab = tabs.find((t) => t.url && positionKey(t.url) === positionKey(url));
  if (SURFACE === 'panel') setPanelView('reading');
  if (tab) { await chrome.tabs.update(tab.id, { active: true }); await loadFromTab(tab.id, {}); return; }
  tab = await chrome.tabs.create({ url, active: SURFACE === 'panel' });
  await new Promise((resolve) => {
    const onUpd = (id, info) => { if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(onUpd); resolve(); } };
    chrome.tabs.onUpdated.addListener(onUpd);
    setTimeout(resolve, 15000);
  });
  await new Promise((r) => setTimeout(r, 400));
  await loadFromTab(tab.id, {});
}

// ---------- reading queue ----------
async function loadQueue() {
  const { queue = [] } = await chrome.storage.local.get('queue');
  state.queue = queue;
}
async function saveQueue() { await chrome.storage.local.set({ queue: state.queue }); }
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.queue) { state.queue = changes.queue.newValue || []; if (state.panelView === 'library' || !state.loaded) renderLibrary(); }
});
async function startQueue(fromIndex) {
  if (!state.queue.length) return;
  state.queueMode = true;
  if (SURFACE === 'panel') setPanelView('reading');
  await playQueueItem(state.queue[Math.max(0, Math.min(fromIndex || 0, state.queue.length - 1))]);
}
async function playQueueItem(item) {
  state.queueCurrentId = item.id;
  state.queueOpenedTab = null;
  const tabs = await chrome.tabs.query({ currentWindow: true });
  let tab = tabs.find((t) => t.url && positionKey(t.url) === positionKey(item.url));
  if (!tab) {
    tab = await chrome.tabs.create({ url: item.url, active: false });
    state.queueOpenedTab = tab.id;
    await new Promise((resolve) => {
      const onUpd = (id, info) => { if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(onUpd); resolve(); } };
      chrome.tabs.onUpdated.addListener(onUpd);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpd); resolve(); }, 20000);
    });
    await new Promise((r) => setTimeout(r, 500));
  }
  const ok = await loadFromTab(tab.id, {});
  if (ok) {
    const q = state.queue.find((x) => x.id === item.id);
    if (q && state.title && q.title !== state.title) { q.title = state.title; await saveQueue(); }
    const cur = state.queue.findIndex((it) => it.id === state.queueCurrentId);
    if (cur >= 0 && cur < state.queue.length - 1) showRibbon('info', `Up next: ${state.queue[cur + 1].title || state.queue[cur + 1].url}${state.queue.length - cur - 2 > 0 ? ` · ${state.queue.length - cur - 2} more` : ''}`);
  } else {
    await finishQueueItem(false);
  }
}
async function finishQueueItem(advance = true) {
  const id = state.queueCurrentId;
  const idx = state.queue.findIndex((x) => x.id === id);
  if (idx >= 0) { state.queue.splice(idx, 1); await saveQueue(); }
  if (state.queueOpenedTab !== null && state.settings.closeQueueTabs) { try { await chrome.tabs.remove(state.queueOpenedTab); } catch (_) {} }
  state.queueOpenedTab = null;
  state.queueCurrentId = null;
  if (advance && state.queue.length && state.queueMode) {
    const next = state.queue[Math.min(idx, state.queue.length - 1)] || state.queue[0];
    await playQueueItem(next);
  } else {
    state.queueMode = false;
    if (advance) showRibbon('info', 'Queue finished.');
  }
}

// ---------- ribbon: resume, notices, progress ----------
let ribbonKind = '';
const RIBBON_ICONS = {
  resume: '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>',
  info: '<circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path>',
  error: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path>',
  progress: '<path d="M12 17V3"></path><path d="m6 11 6 6 6-6"></path><path d="M19 21H5"></path>'
};
function showRibbon(kind, msg, o = {}) {
  if (!els.ribbon) return;
  ribbonKind = kind;
  els.ribbon.hidden = false;
  els.ribbon.classList.toggle('error', kind === 'error');
  if (els.ribbonIcon) els.ribbonIcon.innerHTML = RIBBON_ICONS[kind] || RIBBON_ICONS.info;
  els.ribbonMsg.innerHTML = '';
  els.ribbonMsg.appendChild(document.createTextNode(msg));
  if (kind === 'progress' && typeof o.pct === 'number') {
    const bar = document.createElement('span'); bar.className = 'bar'; const i = document.createElement('i'); i.style.width = `${o.pct}%`; bar.appendChild(i); els.ribbonMsg.appendChild(bar);
  }
  if (o.action) { els.ribbonBtn.hidden = false; els.ribbonBtn.textContent = o.action; } else els.ribbonBtn.hidden = true;
}
function hideRibbon() { if (els.ribbon) els.ribbon.hidden = true; ribbonKind = ''; }
function notice(msg, isError) { if (!msg) { hideRibbon(); return; } showRibbon(isError ? 'error' : 'info', msg); }
on(els.ribbonBtn, 'click', () => {
  if (ribbonKind === 'resume' || ribbonKind === 'info') { state.idx = 0; state.resumedFrom = null; hideRibbon(); play(); }
});

// ---------- views ----------
function showView(v) {
  show(els.viewFirstRun, v === 'firstrun');
  show(els.viewReading, v === 'reading');
}
function setPanelView(v) {
  if (SURFACE === 'reader' && v === 'contents') v = 'reading';
  state.panelView = v;
  show(els.transcript, v === 'reading');
  show(els.btnJump, v === 'reading' && state.followSuspended);
  show(els.panelContents, v === 'contents');
  show(els.panelVoice, v === 'voice');
  show(els.panelLibrary, v === 'library');
  show(els.btnCloseLibrary, state.loaded);
  if (els.chipContents) { els.chipContents.classList.toggle('on', v === 'contents'); els.chipContents.setAttribute('aria-expanded', String(v === 'contents')); }
  if (els.chipVoice) { els.chipVoice.classList.toggle('on', v === 'voice'); els.chipVoice.setAttribute('aria-expanded', String(v === 'voice')); }
  if (v === 'contents') renderToc();
  if (v === 'voice') { renderVoiceLists(); updateEngineHint(); renderSleepUI(); if (state.settings.voiceboxEnabled && (state.settings.engine === 'voicebox' || voiceboxUp === null)) refreshVoicebox(); }
  if (v === 'library') renderLibrary();
  if (v === 'reading') { stopSample(); requestAnimationFrame(() => followCurrent(true)); }
  renderNowPlaying();
}
function toggleView(v) { setPanelView(state.panelView === v ? 'reading' : v); }
function showNothingLoaded() {
  state.loaded = false;
  showView('reading');
  setPanelView(SURFACE === 'panel' ? 'library' : 'reading');
  describeActiveTab();
}

// ---------- first run ----------
function finishFirstRun() { state.settings.onboarded = true; saveSettings(); }
on(els.frRead, 'click', async () => { finishFirstRun(); showView('reading'); setPanelView('reading'); await loadFromTab(null, {}); if (!state.loaded) showNothingLoaded(); });
on(els.frVoice, 'click', (e) => { e.preventDefault(); finishFirstRun(); showNothingLoaded(); setPanelView('voice'); });

// ---------- playback ownership between surfaces ----------
async function claimPlayback() {
  try { await chrome.storage.session.set({ owner: { id: SURFACE_ID, surface: SURFACE, ts: Date.now() } }); } catch (_) {}
  chrome.runtime.sendMessage({ type: 'ra:claim', id: SURFACE_ID }).catch(() => {});
}
async function iAmOwner() {
  try {
    const { owner } = await chrome.storage.session.get('owner');
    if (!owner) return SURFACE === 'panel';
    if (owner.id === SURFACE_ID) return true;
    if (owner.surface === 'reader' && SURFACE === 'panel' && Date.now() - owner.ts < 6 * 3600000) return false;
    return SURFACE === 'panel';
  } catch (_) { return SURFACE === 'panel'; }
}

// ---------- requests from background / content / popup ----------
async function handleRequest(p) {
  if (!p || !p.action) return { ok: false };
  if (p.ts && p.ts === state.lastHandledTs) return { ok: true, dup: true };
  if (p.ts) state.lastHandledTs = p.ts;
  chrome.storage.session.remove('pending').catch(() => {});
  chrome.runtime.sendMessage({ type: 'ra:clearBadge' }).catch(() => {});
  if (!state.settings.onboarded) finishFirstRun();
  if (els.viewReading && els.viewReading.hidden) { showView('reading'); }
  switch (p.action) {
    case 'readTab': setPanelView('reading'); await loadFromTab(p.tabId, { blockIndex: typeof p.blockIndex === 'number' ? p.blockIndex : undefined }); return { ok: true };
    case 'readSelection': setPanelView('reading'); await loadSelection(p.tabId, p.fallbackText); return { ok: true };
    case 'togglePlay': if (!state.units.length) { setPanelView('reading'); await loadFromTab(p.tabId, {}); } else togglePlay(); return { ok: true };
    case 'playQueueItem': { const it = state.queue.find((x) => x.id === p.id); if (it) { state.queueMode = true; await playQueueItem(it); } return { ok: true }; }
    case 'prev': step(-1); return { ok: true };
    case 'next': step(1); return { ok: true };
    default: return { ok: false };
  }
}
function statusForPopup() {
  const total = state.units.length;
  const ci = state.chapterIdx;
  return {
    ok: true, loaded: state.loaded && total > 0, title: state.title, kind: kindLabel(state.kind), source: state.source,
    left: state.loaded ? fmtLeft(secondsFrom(state.idx)) : '', rate: fmtRate(state.settings.rate), voice: currentVoiceName(),
    fraction: total ? state.idx / total : 0,
    state: state.waiting ? 'waiting' : state.playing && !state.paused ? 'playing' : state.paused ? 'paused' : 'stopped',
    chapters: state.chapters.map((c, i) => ({ flex: Math.max(1, Math.round(chapterSeconds(c))), state: i < ci ? 'past' : i === ci ? 'current' : 'future', fill: i === ci ? Math.round(((state.idx - c.startUnit) / Math.max(1, c.endUnit - c.startUnit)) * 100) : 0 }))
  };
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'ra:panel') {
    iAmOwner().then((mine) => { if (!mine) { sendResponse({ ok: false, notOwner: true }); return; } return handleRequest(msg.payload).then(sendResponse, () => sendResponse({ ok: false })); });
    return true;
  }
  if (msg.type === 'ra:status?') {
    iAmOwner().then((mine) => sendResponse(mine ? statusForPopup() : { ok: false, notOwner: true }));
    return true;
  }
  if (msg.type === 'ra:claim' && msg.id !== SURFACE_ID) {
    if (state.playing) { stopSpeech(); savePosition(); showRibbon('info', SURFACE === 'panel' ? 'Reading moved to the full-tab reader.' : 'Reading moved to the side panel.'); }
    return false;
  }
  return false;
});
async function checkPending() {
  const { pending } = await chrome.storage.session.get('pending');
  if (pending && Date.now() - (pending.ts || 0) < 60000) { await handleRequest(pending); return true; }
  return false;
}
chrome.tabs.onRemoved.addListener((tabId) => { if (tabId === state.tabId) state.canHighlight = false; });
chrome.tabs.onUpdated.addListener((tabId, info) => { if (tabId === state.tabId && info.status === 'loading' && info.url && info.url !== state.url) state.canHighlight = false; });
chrome.tabs.onActivated.addListener(() => { if (!state.loaded && SURFACE === 'panel') describeActiveTab(); });

// ---------- UI wiring ----------
on(els.btnPlay, 'click', togglePlay);
on(els.btnPrev, 'click', () => step(-1));
on(els.btnNext, 'click', () => step(1));
on(els.chipContents, 'click', () => toggleView('contents'));
on(els.chipVoice, 'click', () => toggleView('voice'));
on(els.btnNpClose, 'click', () => setPanelView('reading'));
on(els.btnCloseVoice, 'click', () => setPanelView(state.loaded ? 'reading' : 'library'));
on(els.btnCloseLibrary, 'click', () => setPanelView('reading'));
on(els.btnLibrary, 'click', () => setPanelView('library'));
on(els.rVoice, 'click', () => toggleView('voice'));
on(els.btnReader, 'click', async () => {
  const url = chrome.runtime.getURL(`reader.html${state.tabId !== null ? `?tab=${state.tabId}` : ''}`);
  stopSpeech(); savePosition();
  await chrome.tabs.create({ url, active: true });
});
on(els.btnStop, 'click', () => { stop(); setPanelView('reading'); });
on(els.btnRerunSetup, 'click', () => { stop(); state.settings.onboarded = false; saveSettings(); showView('firstrun'); });
on(els.voiceList, 'click', onVoiceListClick);
on(els.voiceListOther, 'click', onVoiceListClick);
on(els.btnOtherLangs, 'click', () => { otherLangsOpen = !otherLangsOpen; renderVoiceLists(); });

function setRate(r, restart) {
  state.settings.rate = Math.round(Number(r) * 10) / 10;
  if (els.rate) els.rate.value = state.settings.rate;
  txt(els.rateLabel, fmtRateLong(state.settings.rate));
  renderNowPlaying();
  saveSettings();
  if (restart && state.playing && !state.paused) speakCurrent();
}
on(els.rate, 'input', () => setRate(els.rate.value, false));
on(els.rate, 'change', () => setRate(els.rate.value, true));

on(els.segEngine, 'click', async (e) => {
  const b = e.target.closest('button[data-engine]');
  if (!b) return;
  const eng = b.dataset.engine;
  if (eng === state.settings.engine) return;
  const wasPlaying = state.playing && !state.paused;
  stopSpeech(true); stopSample();
  state.settings.engine = eng;
  saveSettings();
  updateEngineHint(); renderVoiceLists(); renderNowPlaying();
  if (eng === 'kokoro') warmKokoro();
  if (eng === 'voicebox') { await refreshVoicebox(); warmVoicebox(); }
  if (wasPlaying) play();
});
on(els.segVbEngine, 'click', (e) => {
  const b = e.target.closest('button[data-gen]');
  if (!b || b.dataset.gen === state.settings.voiceboxEngine) return;
  const wasPlaying = state.playing && !state.paused;
  stopSpeech(true);
  if (voicebox) { voicebox.flush(); voicebox.resetStats(); }
  state.settings.voiceboxEngine = b.dataset.gen;
  voiceboxWarned = false;
  saveSettings();
  renderVoiceboxGen();
  warmVoicebox();
  if (wasPlaying) play();
});
function renderDict() {
  if (!els.dictList) return;
  els.dictList.innerHTML = '';
  const rules = state.settings.pronunciations || [];
  if (!rules.length) { const d = document.createElement('div'); d.className = 'hint'; d.textContent = 'No rules yet. Add a name or term and how it should be said.'; els.dictList.appendChild(d); return; }
  rules.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'dict-row';
    row.innerHTML = '<span class="from"></span><span class="arrow">→</span><span class="to"></span><button class="x" aria-label="Remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button>';
    row.querySelector('.from').textContent = r.from;
    row.querySelector('.to').textContent = r.to;
    row.querySelector('.x').addEventListener('click', () => { state.settings.pronunciations.splice(i, 1); saveSettings(); renderDict(); rebuildUnitsInPlace(); });
    els.dictList.appendChild(row);
  });
}
function addDictRule() {
  const from = els.dictFrom.value.trim(), to = els.dictTo.value.trim();
  if (!from || !to) return;
  state.settings.pronunciations = (state.settings.pronunciations || []).filter((r) => r.from.toLowerCase() !== from.toLowerCase());
  state.settings.pronunciations.push({ from, to });
  saveSettings();
  els.dictFrom.value = ''; els.dictTo.value = '';
  renderDict();
  rebuildUnitsInPlace();
}
on(els.btnDictAdd, 'click', addDictRule);
on(els.dictTo, 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addDictRule(); } });
on(els.segSleep, 'click', (e) => {
  const b = e.target.closest('button[data-sleep]');
  if (!b) return;
  if (b.dataset.sleep === 'minutes') setSleep('minutes', Number(b.dataset.min)); else setSleep(b.dataset.sleep);
});
on(els.closeQueueTabs, 'change', () => { state.settings.closeQueueTabs = els.closeQueueTabs.checked; saveSettings(); });
on(els.followScroll, 'change', () => { state.settings.followPanel = true; state.followSuspended = false; show(els.btnJump, false); saveSettings(); followCurrent(true); });
on(els.followStill, 'change', () => { state.settings.followPanel = false; state.followSuspended = false; show(els.btnJump, false); saveSettings(); });
on(els.wordHighlight, 'change', () => { state.settings.wordHighlight = els.wordHighlight.checked; saveSettings(); });
on(els.showController, 'change', () => { state.settings.showController = els.showController.checked; saveSettings(); pushStatus(); if (!state.settings.showController && state.tabId !== null) chrome.tabs.sendMessage(state.tabId, { type: 'ra:controller', on: false }).catch(() => {}); });

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (e.key === 'Escape' && state.panelView !== 'reading') { setPanelView(state.loaded ? 'reading' : 'library'); return; }
  if (els.viewReading && els.viewReading.hidden) return;
  if (e.key === ' ' && !(t && t.closest && t.closest('button'))) { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
});
window.addEventListener('unload', () => {
  stopSpeech(true);
  try { chrome.storage.session.get('owner').then(({ owner }) => { if (owner && owner.id === SURFACE_ID) chrome.storage.session.remove('owner'); }); } catch (_) {}
});
window.addEventListener('resize', () => { if (state.loaded) followCurrent(false); });

// Debug API used by the automated screenshot checks; not part of the UI.
window.__raApi = { loadFromTab, setPanelView, showView, togglePlay, step, pause, play, notice, showRibbon, renderLibrary, showNothingLoaded };

// ---------- boot ----------
(async () => {
  await loadSettings();
  await loadSystemVoices();
  await loadQueue();
  renderVoiceLists();
  updateEngineHint();
  prunePositions();
  const params = new URLSearchParams(location.search);
  if (SURFACE === 'reader') {
    if (!state.settings.onboarded) finishFirstRun();
    showView('reading'); setPanelView('reading');
    const tabParam = params.get('tab');
    const ok = await loadFromTab(tabParam ? Number(tabParam) : null, { autoplay: params.get('autoplay') !== '0' });
    if (!ok) showNothingLoaded();
  } else {
    const handled = await checkPending();
    if (!handled) {
      if (!state.settings.onboarded) showView('firstrun');
      else showNothingLoaded();
    }
  }
  if (state.settings.engine === 'kokoro' && state.settings.onboarded) warmKokoro({ silent: true });
  if (state.settings.engine === 'voicebox' && state.settings.voiceboxEnabled) refreshVoicebox();
})();

// Unabridged - voice engines.
// Two engines behind one interface:
//   SystemEngine  - the browser's own voices through chrome.tts (instant, no download)
//   KokoroEngine  - Kokoro-82M running locally (WebGPU or WASM) in a worker,
//                   with look-ahead synthesis so playback never gaps.
//   VoiceboxEngine - the Voicebox app's local server, for cloned voices.
//
// Interface used by the player:
//   await engine.ready()                       resolves when the engine can speak
//   engine.speak(unit, opts)                   opts: {rate, voice, onStart, onWord, onEnd, onError}
//   engine.prefetch(units, {rate, voice})      warm the cache (Kokoro only)
//   engine.pause() / engine.resume() / engine.stop()
//   engine.voices()                            [{id, name, note}]

export const KOKORO_VOICES = [
  { id: 'af_heart',   name: 'Heart',   note: 'American, warm, even pace', grade: 'A' },
  { id: 'af_bella',   name: 'Bella',   note: 'American, bright, expressive', grade: 'A-' },
  { id: 'af_nicole',  name: 'Nicole',  note: 'American, soft, close-mic', grade: 'B-' },
  { id: 'am_michael', name: 'Michael', note: 'American, low, measured', grade: 'B' },
  { id: 'am_fenrir',  name: 'Fenrir',  note: 'American, deep, deliberate', grade: 'B' },
  { id: 'am_puck',    name: 'Puck',    note: 'American, light, quick', grade: 'B' },
  { id: 'bf_emma',    name: 'Emma',    note: 'British, clear, narrator', grade: 'B-' },
  { id: 'bm_george',  name: 'George',  note: 'British, crisp, narrator', grade: 'B' },
  { id: 'bm_fable',   name: 'Fable',   note: 'British, storyteller', grade: 'B' }
];

// Kokoro's speed parameter stays natural up to about 1.6x. Beyond that we
// stretch playback slightly, which is inaudible up to roughly 1.3x on top.
const GEN_SPEED_MIN = 0.6;
const GEN_SPEED_MAX = 1.6;
const SAMPLE_RATE = 24000;
const CACHE_LIMIT = 24;
const LOOKAHEAD = 3;

// Approximate per-word timing by distributing the clip's duration across
// words weighted by length. Kokoro returns no timestamps; this is close
// enough for a following highlight and gets replaced by phoneme alignment later.
function wordTimeline(text, durationSec) {
  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) words.push({ start: m.index, length: m[0].length });
  const weights = words.map((w) => w.length + 1.2);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = 0;
  return words.map((w, i) => {
    const at = t;
    t += (weights[i] / total) * durationSec;
    return { at, start: w.start, length: w.length };
  });
}

// ---------- System voices (chrome.tts) ----------
export class SystemEngine {
  constructor() { this.kind = 'system'; this._token = 0; this._paused = false; }
  async ready() { return true; }
  voices() {
    return new Promise((resolve) => {
      chrome.tts.getVoices((vs) => resolve((vs || []).filter((v) => v.voiceName).map((v) => ({ id: v.voiceName, name: v.voiceName, note: v.lang || '', lang: v.lang }))));
    });
  }
  prefetch() {}
  speak(unit, opts) {
    const myToken = ++this._token;
    if (this._paused) { this._paused = false; chrome.tts.resume(); }
    chrome.tts.speak(unit.spoken, {
      rate: opts.rate || 1,
      voiceName: opts.voice || undefined,
      enqueue: false,
      onEvent: (ev) => {
        if (myToken !== this._token) return;
        if (ev.type === 'start') opts.onStart && opts.onStart();
        else if (ev.type === 'word' && typeof ev.charIndex === 'number') opts.onWord && opts.onWord(ev.charIndex, ev.length);
        else if (ev.type === 'end') opts.onEnd && opts.onEnd();
        else if (ev.type === 'error') opts.onError && opts.onError(ev.errorMessage || 'unknown');
      }
    }, () => {
      if (chrome.runtime.lastError && opts.onError) opts.onError(chrome.runtime.lastError.message);
    });
  }
  pause() { this._paused = true; chrome.tts.pause(); }
  resume() { this._paused = false; chrome.tts.resume(); }
  stop() { this._token += 1; this._paused = false; try { chrome.tts.stop(); } catch (_) {} }
}

// ---------- Kokoro (local neural) ----------
export class KokoroEngine {
  constructor({ onProgress, remoteHost } = {}) {
    this.kind = 'kokoro';
    this.remoteHost = remoteHost || null;
    this.tts = null;
    this.device = null;
    this.loading = null;
    this.onProgress = onProgress || (() => {});
    this.ctx = null;
    this.cache = new Map();      // key -> AudioBuffer | Promise<AudioBuffer>
    this.order = [];             // cache keys, oldest first
    this.queue = Promise.resolve(); // serializes model calls
    this._source = null;
    this._token = 0;
    this._timers = [];
    this._pausedAt = null;
  }

  static async available() {
    try { return !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch (_) { return false; }
  }

  async ready() {
    if (this.tts) return true;
    if (!this.loading) this.loading = this._load();
    await this.loading;
    return true;
  }

  async _load() {
    const threads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    this.worker = new Worker(chrome.runtime.getURL('kokoro-worker.js'), { type: 'module' });
    this._pending = new Map();
    this._nextId = 1;
    const files = new Map();
    this.worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'progress') {
        const p = m.p;
        if (p && p.file && (p.status === 'progress' || p.status === 'done')) {
          files.set(p.file, { loaded: p.loaded || (p.status === 'done' ? p.total : 0) || 0, total: p.total || 0 });
          let loaded = 0, total = 0;
          for (const f of files.values()) { loaded += f.loaded; total += f.total; }
          this.onProgress({ status: p.status, loaded, total, file: p.file });
        }
        return;
      }
      if (m.type === 'fallback') { this.onProgress({ status: 'fallback', message: m.message }); return; }
      const slot = this._pending.get(m.id);
      if (!slot) return;
      this._pending.delete(m.id);
      if (m.type === 'error') slot.reject(new Error(m.message));
      else slot.resolve(m);
    };
    this.worker.onerror = (e) => {
      for (const slot of this._pending.values()) slot.reject(new Error(e.message || 'worker error'));
      this._pending.clear();
    };
    const ready = await this._call({
      type: 'load',
      bundleUrl: chrome.runtime.getURL('vendor/kokoro.bundle.mjs'),
      wasmDir: chrome.runtime.getURL('vendor/ort/'),
      numThreads: self.crossOriginIsolated ? threads : 1,
      remoteHost: this.remoteHost || undefined,
      device: 'auto'
    });
    this.device = ready.device;
    this.tts = true;
    this.onProgress({ status: 'ready', device: this.device });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  }

  _call(msg) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  voices() { return Promise.resolve(KOKORO_VOICES.slice()); }

  _plan(rate) {
    const r = Number(rate) || 1;
    const gen = Math.min(GEN_SPEED_MAX, Math.max(GEN_SPEED_MIN, r));
    return { gen: Math.round(gen * 100) / 100, stretch: r / gen };
  }

  _key(unit, voice, gen) { return `${voice}|${gen}|${unit.spoken}`; }

  _synth(unit, voice, gen) {
    const key = this._key(unit, voice, gen);
    if (this.cache.has(key)) return this.cache.get(key);
    const p = this.queue.then(async () => {
      const audio = await this._call({ type: 'generate', text: unit.spoken, voice, speed: gen });
      const buf = this.ctx.createBuffer(1, audio.data.length, audio.sr || SAMPLE_RATE);
      buf.getChannelData(0).set(audio.data);
      return buf;
    });
    // Keep the chain alive even if one clip fails.
    this.queue = p.catch(() => {});
    this.cache.set(key, p);
    this.order.push(key);
    while (this.order.length > CACHE_LIMIT) this.cache.delete(this.order.shift());
    p.then((buf) => { if (this.cache.get(key) === p) this.cache.set(key, buf); }, () => { this.cache.delete(key); });
    return p;
  }

  prefetch(units, { rate, voice }) {
    if (!this.tts) return;
    const { gen } = this._plan(rate);
    for (const u of units.slice(0, LOOKAHEAD)) this._synth(u, voice, gen);
  }

  async speak(unit, opts) {
    const myToken = ++this._token;
    this._clearTimers();
    if (this._source) { try { this._source.stop(); } catch (_) {} this._source = null; }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    const { gen, stretch } = this._plan(opts.rate);
    let buffer;
    try {
      buffer = await this._synth(unit, opts.voice, gen);
    } catch (e) {
      if (myToken === this._token && opts.onError) opts.onError(String(e && e.message || e));
      return;
    }
    if (myToken !== this._token) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = stretch;
    src.connect(this.ctx.destination);
    const durationSec = buffer.duration / stretch;
    src.onended = () => {
      if (myToken !== this._token) return;
      this._source = null;
      this._clearTimers();
      opts.onEnd && opts.onEnd();
    };
    this._source = src;
    src.start();
    opts.onStart && opts.onStart();
    if (opts.onWord) {
      for (const w of wordTimeline(unit.spoken, durationSec)) {
        this._timers.push(setTimeout(() => { if (myToken === this._token) opts.onWord(w.start, w.length); }, w.at * 1000));
      }
    }
  }

  _clearTimers() { for (const t of this._timers) clearTimeout(t); this._timers = []; }

  pause() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this._pausedAt = this.ctx.currentTime;
    this.ctx.suspend();
    // Freeze word timers by clearing them; a resume re-speaks from the sentence start
    // only if the player asks. Simpler: leave timers, they fire against wall-clock,
    // so clear and let the sentence-level highlight stand while paused.
    this._clearTimers();
  }

  resume() {
    if (!this.ctx || this.ctx.state !== 'suspended') return;
    this.ctx.resume();
  }

  stop() {
    this._token += 1;
    this._clearTimers();
    if (this._source) { try { this._source.stop(); } catch (_) {} this._source = null; }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  async isCached() {
    try {
      const cache = await caches.open('transformers-cache');
      const keys = await cache.keys();
      return keys.some((r) => /Kokoro-82M-v1\.0-ONNX\/resolve\/main\/onnx\/model/.test(r.url));
    } catch (_) { return false; }
  }
}

// ---------- Voicebox (local voice studio server) ----------
// Talks to the Voicebox app (github.com/jamiepine/voicebox) running on this
// machine. POST /generate/stream returns WAV for a voice profile, including
// voices the user cloned themselves. Verified against backend/routes/generations.py
// and backend/models.py at commit 51f49de (2026-07-26).
export const VOICEBOX_URL = 'http://127.0.0.1:17493';
const VOICEBOX_TIMEOUT_MS = 180000;

export class VoiceboxEngine {
  constructor({ baseUrl } = {}) {
    this.kind = 'voicebox';
    this.baseUrl = (baseUrl || VOICEBOX_URL).replace(/\/$/, '');
    this.ctx = null;
    this.cache = new Map();
    this.order = [];
    this.inflight = 0;
    this._source = null;
    this._token = 0;
    this._timers = [];
    this.profiles = [];
  }

  async ready() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const r = await fetch(`${this.baseUrl}/`, { method: 'GET' });
    if (!r.ok) throw new Error(`Voicebox answered HTTP ${r.status}`);
    return true;
  }

  static async probe(baseUrl) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(`${(baseUrl || VOICEBOX_URL).replace(/\/$/, '')}/profiles`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return { up: false };
      const list = await r.json();
      return { up: true, profiles: Array.isArray(list) ? list : [] };
    } catch (_) { return { up: false }; }
  }

  async voices() {
    const r = await fetch(`${this.baseUrl}/profiles`);
    if (!r.ok) throw new Error(`Could not list Voicebox profiles (HTTP ${r.status}).`);
    const list = await r.json();
    this.profiles = (Array.isArray(list) ? list : []).map((p) => ({
      id: p.id, name: p.name,
      note: [p.voice_type === 'cloned' ? 'Cloned voice' : 'Preset', p.default_engine || p.preset_engine || ''].filter(Boolean).join(' · '),
      lang: p.language
    }));
    return this.profiles;
  }

  _key(unit, voice) { return `${voice}|${unit.spoken}`; }

  _synth(unit, voice) {
    const key = this._key(unit, voice);
    if (this.cache.has(key)) return this.cache.get(key);
    const p = (async () => {
      this.inflight += 1;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), VOICEBOX_TIMEOUT_MS);
      try {
        const r = await fetch(`${this.baseUrl}/generate/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: ctrl.signal,
          // engine: null lets the server use the profile's own default engine.
          body: JSON.stringify({ profile_id: voice, text: unit.spoken, language: 'en', engine: null, normalize: true })
        });
        if (!r.ok) {
          let detail = '';
          try { detail = (await r.json()).detail || ''; } catch (_) {}
          throw new Error(`Voicebox HTTP ${r.status}${detail ? `: ${detail}` : ''}`);
        }
        const bytes = await r.arrayBuffer();
        if (!bytes.byteLength) throw new Error('Voicebox returned no audio for this sentence.');
        return await this.ctx.decodeAudioData(bytes);
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error(`Voicebox took longer than ${Math.round(VOICEBOX_TIMEOUT_MS / 1000)} seconds to generate a sentence. Check the Voicebox app for errors or a model still downloading.`);
        throw e;
      } finally { clearTimeout(timer); this.inflight -= 1; }
    })();
    this.cache.set(key, p);
    this.order.push(key);
    while (this.order.length > CACHE_LIMIT) this.cache.delete(this.order.shift());
    p.then((buf) => { if (this.cache.get(key) === p) this.cache.set(key, buf); }, () => { this.cache.delete(key); });
    return p;
  }

  prefetch(units, { voice }) {
    // The server runs one model; two requests in flight keeps it busy without a pile-up.
    for (const u of units.slice(0, 2)) if (this.inflight < 2) this._synth(u, voice);
  }

  // Ask for one short clip so Voicebox loads the profile's model before the
  // user presses play. The first request after launch can take a minute.
  warm(voice) {
    if (!voice) return Promise.resolve();
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this._synth({ spoken: 'Ready.' }, voice).then(() => true, () => false);
  }

  async speak(unit, opts) {
    const myToken = ++this._token;
    this._clearTimers();
    if (this._source) { try { this._source.stop(); } catch (_) {} this._source = null; }
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    let buffer;
    try { buffer = await this._synth(unit, opts.voice); } catch (e) {
      if (myToken === this._token && opts.onError) opts.onError(String(e && e.message || e));
      return;
    }
    if (myToken !== this._token) return;
    const rate = Number(opts.rate) || 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(this.ctx.destination);
    const durationSec = buffer.duration / rate;
    src.onended = () => { if (myToken !== this._token) return; this._source = null; this._clearTimers(); opts.onEnd && opts.onEnd(); };
    this._source = src;
    src.start();
    opts.onStart && opts.onStart();
    if (opts.onWord) {
      for (const w of wordTimeline(unit.spoken, durationSec)) {
        this._timers.push(setTimeout(() => { if (myToken === this._token) opts.onWord(w.start, w.length); }, w.at * 1000));
      }
    }
  }
  _clearTimers() { for (const t of this._timers) clearTimeout(t); this._timers = []; }
  pause() { if (this.ctx && this.ctx.state === 'running') { this.ctx.suspend(); this._clearTimers(); } }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  stop() {
    this._token += 1; this._clearTimers();
    if (this._source) { try { this._source.stop(); } catch (_) {} this._source = null; }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
}

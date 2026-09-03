// Unabridged - voice engines.
// Two engines behind one interface:
//   SystemEngine  - the browser's own voices through chrome.tts (instant, no download)
//   KokoroEngine  - Kokoro-82M running locally (WebGPU or WASM) in a worker,
//                   with look-ahead synthesis so playback never gaps.
//
// Interface used by the player:
//   await engine.ready()                       resolves when the engine can speak
//   engine.speak(unit, opts)                   opts: {rate, voice, onStart, onWord, onEnd, onError}
//                                              onWord(charIndex, length) fires only from engines with real word boundaries
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

// Word-level events: only the system engine (chrome.tts) reports real word
// boundaries. Kokoro returns audio with no alignment, so it emits
// no word events at all and the player shows the sentence tint only. A timed
// estimate was tried and dropped: karaoke that drifts is worse than none.

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
    this.hasWordEvents = true;
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
    this.durationSec = durationSec;
    opts.onStart && opts.onStart();
  }

  _clearTimers() { for (const t of this._timers) clearTimeout(t); this._timers = []; }

  pause() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this._pausedAt = this.ctx.currentTime;
    this.ctx.suspend();
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

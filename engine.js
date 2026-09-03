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

// ---------- Voicebox (local voice studio server) ----------
// Talks to the Voicebox app (github.com/jamiepine/voicebox, MIT) on this
// machine. Verified against backend/routes/generations.py, routes/models.py
// and models.py on main, 2026-09-03:
//   GET  /profiles                 voice profiles (id, name, voice_type, default_engine, preset_engine)
//   POST /generate/stream          {profile_id, text, language, engine, max_chunk_chars, normalize} -> WAV,
//                                  sent only after the whole clip is generated
//   GET  /models/status            [{model_name, display_name, downloaded, downloading, loaded, size_mb}]
//   POST /models/download          {model_name}
// The server has no auth and generates one request at a time, so this engine
// keeps a single request in flight and a deep buffer of finished clips.
export const VOICEBOX_URL = 'http://127.0.0.1:17493';
export const VOICEBOX_ENGINES = [
  { id: 'auto', name: 'Profile default', note: 'Whatever the profile chose in Voicebox' },
  { id: 'chatterbox_turbo', name: 'Chatterbox Turbo', note: 'Fastest with a cloned voice' },
  { id: 'chatterbox', name: 'Chatterbox', note: 'Cloned voice, slower, a little richer' },
  { id: 'qwen', name: 'Qwen 1.7B', note: 'Best quality, slowest' },
  { id: 'luxtts', name: 'LuxTTS', note: 'Light and quick' }
];
const VOICEBOX_TIMEOUT_MS = 240000;
const VOICEBOX_DEPTH = 6;

export class VoiceboxEngine {
  constructor({ baseUrl, onStatus } = {}) {
    this.kind = 'voicebox';
    this.lookahead = VOICEBOX_DEPTH;
    this.baseUrl = (baseUrl || VOICEBOX_URL).replace(/\/$/, '');
    this.onStatus = onStatus || (() => {});
    this.ctx = null;
    this.cache = new Map();
    this.order = [];
    this.chain = Promise.resolve(); // one request in flight at a time
    this.inflight = null;
    this._source = null;
    this._token = 0;
    this.profiles = [];
    this.models = [];
    this.checked = new Set();     // engine keys already verified downloaded
    this.stats = { gen: 0, audio: 0, n: 0 }; // seconds generating vs seconds of audio
  }
  get rtf() { return this.stats.audio > 0 ? this.stats.gen / this.stats.audio : 0; }
  resetStats() { this.stats = { gen: 0, audio: 0, n: 0 }; }

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

  async ready() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); return true; }

  async voices() {
    const r = await fetch(`${this.baseUrl}/profiles`);
    if (!r.ok) throw new Error(`Could not list Voicebox profiles (HTTP ${r.status}).`);
    const list = await r.json();
    this.profiles = (Array.isArray(list) ? list : []).map((p) => ({
      id: p.id, name: p.name, cloned: p.voice_type === 'cloned',
      engine: p.default_engine || p.preset_engine || 'qwen',
      note: [p.voice_type === 'cloned' ? 'Cloned voice' : 'Preset', engineLabel(p.default_engine || p.preset_engine || 'qwen')].join(' · '),
      lang: p.language
    }));
    return this.profiles;
  }

  // Which engine a request will run with, honoring the override for cloned voices only.
  resolveEngine(profileId, override) {
    const p = this.profiles.find((x) => x.id === profileId);
    if (!p) return override && override !== 'auto' ? override : null;
    if (override && override !== 'auto' && p.cloned) return override;
    return p.engine;
  }

  async modelStatus() {
    const r = await fetch(`${this.baseUrl}/models/status`);
    if (!r.ok) return [];
    const j = await r.json();
    this.models = Array.isArray(j) ? j : (j.models || []);
    return this.models;
  }
  _modelFor(engine) {
    const key = String(engine || '').toLowerCase();
    const list = this.models;
    const has = (m, s) => (`${m.model_name} ${m.display_name}`).toLowerCase().replace(/[-\s]/g, '_').includes(s);
    if (key === 'chatterbox') return list.find((m) => has(m, 'chatterbox') && !has(m, 'turbo')) || null;
    if (key === 'qwen' || key === 'qwen_custom_voice') return list.find((m) => has(m, 'qwen') && has(m, '1.7')) || list.find((m) => has(m, 'qwen')) || null;
    return list.find((m) => has(m, key)) || null;
  }

  // Make sure the engine's model is on disk before the first sentence, and say
  // so while it downloads. Loading into memory happens on the first generate.
  async ensureModel(engine) {
    if (!engine || this.checked.has(engine)) return true;
    let models;
    try { models = await this.modelStatus(); } catch (_) { return true; }
    const m = this._modelFor(engine);
    if (!m) { this.checked.add(engine); return true; }
    if (!m.downloaded) {
      if (!m.downloading) {
        try { await fetch(`${this.baseUrl}/models/download`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model_name: m.model_name }) }); } catch (_) {}
      }
      const started = Date.now();
      while (Date.now() - started < 30 * 60000) {
        this.onStatus({ phase: 'download', message: `Voicebox is downloading ${m.display_name || m.model_name}${m.size_mb ? ` (${Math.round(m.size_mb)} MB)` : ''}…` });
        await new Promise((r) => setTimeout(r, 2000));
        await this.modelStatus();
        const cur = this._modelFor(engine);
        if (cur && cur.downloaded) break;
      }
    }
    const cur = this._modelFor(engine);
    if (cur && !cur.loaded) this.onStatus({ phase: 'load', message: `Loading ${cur.display_name || cur.model_name} in Voicebox. The first sentence takes longest.` });
    this.checked.add(engine);
    return true;
  }

  _key(unit, voice, engine) { return `${voice}|${engine || ''}|${unit.spoken}`; }

  _synth(unit, voice, engine) {
    const key = this._key(unit, voice, engine);
    if (this.cache.has(key)) return this.cache.get(key);
    const job = { unit, key, ctrl: new AbortController() };
    const p = this.chain.then(async () => {
      if (job.cancelled) throw new Error('cancelled');
      this.inflight = job;
      const t0 = performance.now();
      const timer = setTimeout(() => job.ctrl.abort(), VOICEBOX_TIMEOUT_MS);
      try {
        const body = { profile_id: voice, text: unit.spoken, language: 'en', max_chunk_chars: 800, normalize: true };
        if (engine) body.engine = engine;
        const r = await fetch(`${this.baseUrl}/generate/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: job.ctrl.signal, body: JSON.stringify(body) });
        if (!r.ok) {
          let detail = '';
          try { detail = (await r.json()).detail || ''; } catch (_) {}
          throw new Error(`Voicebox HTTP ${r.status}${detail ? `: ${detail}` : ''}`);
        }
        const bytes = await r.arrayBuffer();
        if (!bytes.byteLength) throw new Error('Voicebox returned no audio for this sentence.');
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        const buf = await this.ctx.decodeAudioData(bytes);
        const gen = (performance.now() - t0) / 1000;
        this.stats.gen += gen; this.stats.audio += buf.duration; this.stats.n += 1;
        return buf;
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error(job.cancelled ? 'cancelled' : `Voicebox took longer than ${Math.round(VOICEBOX_TIMEOUT_MS / 1000)} seconds on one sentence. Check the Voicebox app for a model still loading.`);
        throw e;
      } finally { clearTimeout(timer); if (this.inflight === job) this.inflight = null; }
    });
    this.chain = p.catch(() => {});
    this.cache.set(key, p);
    this.order.push(key);
    while (this.order.length > CACHE_LIMIT) this.cache.delete(this.order.shift());
    p.then((buf) => { if (this.cache.get(key) === p) this.cache.set(key, buf); }, () => { this.cache.delete(key); });
    p.job = job;
    return p;
  }

  isCached(unit, voice, engine) { const v = this.cache.get(this._key(unit, voice, engine)); return !!(v && !(v instanceof Promise)); }
  // How many of the next units are already finished audio.
  buffered(units, voice, engine) { let n = 0; for (const u of units) { if (this.isCached(u, voice, engine)) n += 1; else break; } return n; }

  prefetch(units, { voice, engine }) {
    for (const u of units.slice(0, VOICEBOX_DEPTH)) this._synth(u, voice, engine);
  }

  warm(voice, engine) {
    return this._synth({ spoken: 'Ready.' }, voice, engine).then(() => true, () => false);
  }

  async speak(unit, opts) {
    const myToken = ++this._token;
    if (this._source) { try { this._source.stop(); } catch (_) {} this._source = null; }
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    let buffer;
    try { buffer = await this._synth(unit, opts.voice, opts.engine); } catch (e) {
      if (myToken === this._token && opts.onError && !/cancelled/.test(String(e && e.message))) opts.onError(String(e && e.message || e));
      return;
    }
    if (myToken !== this._token) return;
    const rate = Number(opts.rate) || 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(this.ctx.destination);
    src.onended = () => { if (myToken !== this._token) return; this._source = null; opts.onEnd && opts.onEnd(); };
    this._source = src;
    src.start();
    this.durationSec = buffer.duration / rate;
    opts.onStart && opts.onStart();
  }
  pause() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  stop() {
    this._token += 1;
    if (this._source) { try { this._source.stop(); } catch (_) {} this._source = null; }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
  // Drop queued work that is no longer ahead of the reader (after a seek).
  flush() {
    if (this.inflight) { this.inflight.cancelled = true; try { this.inflight.ctrl.abort(); } catch (_) {} }
    for (const [k, v] of this.cache) if (v instanceof Promise) { if (v.job) v.job.cancelled = true; this.cache.delete(k); }
    this.order = this.order.filter((k) => this.cache.has(k));
  }
}
function engineLabel(e) { return (VOICEBOX_ENGINES.find((x) => x.id === e) || { name: e === 'qwen_custom_voice' ? 'Qwen' : e || 'Qwen' }).name; }

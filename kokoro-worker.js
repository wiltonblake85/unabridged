// Unabridged - Kokoro worker.
// Runs the model off the panel's main thread so the interface stays responsive
// while sentences are being synthesized (matters most on the WASM fallback).

let k = null;
let tts = null;

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'load') {
      k = await import(m.bundleUrl);
      k.configure({ wasmDir: m.wasmDir, numThreads: m.numThreads, remoteHost: m.remoteHost || undefined });
      const progress = (p) => self.postMessage({ type: 'progress', p: { status: p.status, file: p.file, loaded: p.loaded, total: p.total } });
      let device = m.device;
      if (device === 'auto') device = (await k.hasWebGPU()) ? 'webgpu' : 'wasm';
      try {
        tts = await k.load({ device, progress });
      } catch (err) {
        if (device !== 'webgpu') throw err;
        self.postMessage({ type: 'fallback', message: String(err && err.message || err) });
        tts = await k.load({ device: 'wasm', progress });
      }
      self.postMessage({ type: 'ready', device: tts.__device, id: m.id });
      return;
    }
    if (m.type === 'generate') {
      if (!tts) throw new Error('Model not loaded');
      const audio = await tts.generate(m.text, { voice: m.voice, speed: m.speed });
      const data = audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);
      self.postMessage({ type: 'audio', id: m.id, sr: audio.sampling_rate || 24000, data }, [data.buffer]);
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
};

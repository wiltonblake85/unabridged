// Bundle entry for the Kokoro voice engine inside the Unabridged extension.
// Exposes a small API on top of kokoro-js and transformers.js with the
// runtime wired for a Manifest V3 extension page: local ORT wasm, no CDN,
// model weights fetched from Hugging Face and cached by the browser.
import { env } from '@huggingface/transformers';
import { KokoroTTS } from './kokoro.patched.js';

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export function configure({ wasmDir, remoteHost, numThreads = 1 }) {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
  if (remoteHost) { env.remoteHost = remoteHost; globalThis.__KOKORO_HOST__ = remoteHost; }
  env.backends.onnx.wasm.wasmPaths = wasmDir;
  env.backends.onnx.wasm.numThreads = numThreads;
  env.backends.onnx.wasm.proxy = false;
}

export async function hasWebGPU() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch (_) { return false; }
}

// Load the model. device: 'webgpu' | 'wasm'. Returns a KokoroTTS instance.
export async function load({ device, dtype, progress } = {}) {
  const dev = device || ((await hasWebGPU()) ? 'webgpu' : 'wasm');
  const dt = dtype || (dev === 'webgpu' ? 'fp32' : 'q8');
  const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: dt,
    device: dev,
    progress_callback: progress || null
  });
  tts.__device = dev;
  tts.__dtype = dt;
  return tts;
}

export { KokoroTTS, env };

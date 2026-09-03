#!/usr/bin/env bash
# Builds vendor/kokoro.bundle.mjs for the Unabridged extension.
# kokoro-js hardcodes huggingface.co for voice files; we make the host follow
# transformers.js's env.remoteHost so a mirror (or a future self-host) works.
set -euo pipefail
cd "$(dirname "$0")"
SRC=node_modules/kokoro-js/dist/kokoro.js
PATCHED=kokoro.patched.js
sed 's#`https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${e}.bin`#`${globalThis.__KOKORO_HOST__ || "https://huggingface.co/"}onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${e}.bin`#' "$SRC" > "$PATCHED"
grep -q '__KOKORO_HOST__' "$PATCHED" || { echo "patch did not apply"; exit 1; }
sed -i "s#from './node_modules/kokoro-js/dist/kokoro.js'#from './kokoro.patched.js'#" entry.js
npx esbuild entry.js --bundle --format=esm --platform=browser --target=chrome116 --minify \
  --outfile=kokoro.bundle.mjs \
  --alias:@huggingface/transformers=./node_modules/@huggingface/transformers/dist/transformers.web.js \
  --alias:path=./stub.js --alias:fs/promises=./stub.js \
  --define:process.env.NODE_ENV='"production"'
cp kokoro.bundle.mjs ../vendor/kokoro.bundle.mjs
cp node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm ../vendor/ort/
echo "built $(stat -c %s kokoro.bundle.mjs) bytes"

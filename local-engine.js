/* =========================================================================
 * local-engine.js  —  runs Whisper TINY.EN entirely in the browser.
 * No server, no API key, no cost. Audio never leaves the device.
 * Uses Transformers.js v3 with the WASM backend (works on GitHub Pages,
 * no SharedArrayBuffer / COOP-COEP required, and survives WeChat's
 * limited service-worker support).
 * ========================================================================= */
(function (global) {
  'use strict';

  // ---- Model-weight hosting: probe China-reachable GitHub proxies, then same-origin.
  // Constraint map (all verified empirically):
  //   • Gitee Pages は discontinued.
  //   • hf-mirror redirects big files back to the blocked huggingface.co.
  //   • jsDelivr caps /gh/ files at 20 MB → 403 on our ~30 MB decoder.
  //   • raw.githubusercontent proxies (gh-proxy / ghproxy) serve the FULL 30 MB file
  //     with CORS:* and no size cap — great for weights, which are FETCHED.
  // MIME caveat: those proxies serve .js/.mjs as text/plain, which the browser
  // REFUSES to `import()`. So the ESM lib + ORT wasm glue (which ARE imported) stay
  // same-origin (GitHub Pages, correct MIME, already confirmed working in WeChat).
  // Only the model weights — the 41 MB bottleneck, fetched not imported — get proxied.
  const MODEL_ID = 'whisper-tiny.en';
  const RAW       = 'raw.githubusercontent.com/vpietri-stack/classroom-survivors-speech-poc/master/';
  const MODEL_SOURCES = [
    { name: 'gh-proxy',    base: `https://gh-proxy.com/https://${RAW}` },   // CN GitHub proxy
    { name: 'ghproxy.net', base: `https://ghproxy.net/https://${RAW}` },    // CN GitHub proxy
    { name: 'same-origin', base: new URL('./', location.href).href },       // GitHub Pages fallback
  ];

  // MIME-sensitive assets always same-origin (imported, need real JS MIME).
  const LIB_URL   = new URL('lib/transformers.min.js?v=4', location.href).href;
  const WASM_PATH = new URL('lib/wasm/', location.href).href;

  let transcriber = null;     // cached pipeline
  let loading = null;          // in-flight promise
  let chosen = null;           // winning weight source {name, base} after probe

  function log(msg) { if (global.__speechLog) global.__speechLog(msg); }

  // Probe weight sources in order; first whose config.json answers within timeout wins.
  async function pickSource() {
    if (chosen) return chosen;
    for (const src of MODEL_SOURCES) {
      const url = `${src.base}models/${MODEL_ID}/config.json`;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(timer);
        if (r.ok) { chosen = src; log(`Engine: model host → ${src.name}`); return src; }
        log(`Engine: ${src.name} returned ${r.status}, trying next…`);
      } catch (_) {
        log(`Engine: ${src.name} unreachable, trying next…`);
      }
    }
    chosen = MODEL_SOURCES[MODEL_SOURCES.length - 1];
    log('Engine: all proxies failed probe; using ' + chosen.name);
    return chosen;
  }

  async function load(onProgress) {
    if (transcriber) return transcriber;
    if (loading) return loading;

    loading = (async () => {
      const src = await pickSource();
      const MODEL_DIR = src.base + 'models/';       // …/models/  (parent of the model folder)

      log('Engine: importing transformers.js (same-origin) …');
      const { pipeline, env } = await import(LIB_URL);

      // Weights from the chosen (fast, CN-reachable) mirror; lib+wasm same-origin.
      // allowRemoteModels stays OFF so the blocked huggingface.co is NEVER contacted.
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.localModelPath = MODEL_DIR;
      env.backends.onnx.wasm.proxy = false;
      env.backends.onnx.wasm.wasmPaths = WASM_PATH;

      log('Engine: loading ' + MODEL_ID + ' from ' + src.name + ' (quantized, wasm) — first load ~41 MB …');
      const pipe = await pipeline('automatic-speech-recognition', MODEL_ID, {
        device: 'wasm',
        dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
        progress_callback: (p) => {
          if (onProgress && p.status === 'progress') {
            const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
            onProgress(pct, p.file || '');
          }
        }
      });
      transcriber = pipe;
      log('Engine: ready ✅');
      return pipe;
    })();

    return loading;
  }

  /**
   * @param {Blob|Float32Array} input  16-bit PCM WAV Blob, or raw Float32Array samples
   * @returns {Promise<{text:string, timeSec:number}>}
   */
  const TARGET_SR = 16000;   // Whisper tiny.en expects 16 kHz

  // --- WAV (Blob) → Float32Array PCM in [-1,1], with the file's TRUE sample rate ---
  async function decodeWav(blob) {
    const buf = await blob.arrayBuffer();
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46464952) throw new Error('Not a WAV (RIFF) blob');
    let offset = 12, sampleRate = TARGET_SR, numCh = 1, bits = 16, fmt = 1, dataOff = -1, dataLen = 0;
    while (offset + 8 <= buf.byteLength) {
      const id = dv.getUint32(offset, true);
      const size = dv.getUint32(offset + 4, true);
      if (id === 0x20746d66) {            // 'fmt '
        fmt = dv.getUint16(offset + 8, true);
        numCh = dv.getUint16(offset + 10, true);
        sampleRate = dv.getUint32(offset + 12, true);
        bits = dv.getUint16(offset + 22, true);
      } else if (id === 0x61746164) {     // 'data'
        dataOff = offset + 8; dataLen = size; break;
      }
      offset += 8 + size + (size & 1);
    }
    if (dataOff < 0) throw new Error('WAV: missing data chunk');
    const frames = Math.floor(dataLen / (bits / 8) / numCh);
    const data = new Float32Array(frames);
    let p = dataOff;
    if (fmt === 3) {                       // IEEE float
      const fa = new Float32Array(buf, dataOff, frames * numCh);
      for (let i = 0; i < frames; i++) { let s = 0; for (let c = 0; c < numCh; c++) s += fa[i * numCh + c]; data[i] = s / numCh; }
    } else if (bits === 16) {
      for (let i = 0; i < frames; i++) { let s = 0; for (let c = 0; c < numCh; c++) { s += dv.getInt16(p, true); p += 2; } data[i] = s / numCh / 32768; }
    } else if (bits === 8) {
      for (let i = 0; i < frames; i++) { let s = 0; for (let c = 0; c < numCh; c++) { s += dv.getUint8(p) - 128; p++; } data[i] = s / numCh / 128; }
    } else {
      throw new Error('WAV: unsupported bit depth ' + bits);
    }
    return { data, sampleRate };
  }

  // --- linear-interpolation resample (good enough for ASR) ---
  function resample(audio, fromRate, toRate) {
    if (fromRate === toRate) return audio;
    const ratio = fromRate / toRate;
    const out = new Float32Array(Math.max(1, Math.round(audio.length / ratio)));
    for (let i = 0; i < out.length; i++) {
      const idx = i * ratio, i0 = Math.floor(idx), i1 = Math.min(i0 + 1, audio.length - 1), f = idx - i0;
      out[i] = audio[i0] * (1 - f) + audio[i1] * f;
    }
    return out;
  }

  async function transcribe(input) {
    if (!transcriber) await load();
    let audio, sampleRate;
    if (input instanceof Blob) {
      const { data, sampleRate: sr } = await decodeWav(input);
      audio = data; sampleRate = sr;
    } else if (input instanceof Float32Array) {
      audio = input; sampleRate = TARGET_SR;
    } else {
      throw new Error('transcribe: expected a WAV Blob or Float32Array');
    }
    if (sampleRate !== TARGET_SR) audio = resample(audio, sampleRate, TARGET_SR);
    if (!audio.length) return { text: '(silence / no audio captured)', timeSec: 0 };

    const t0 = performance.now();
    log('Transcribing audio (wasm) …');
    const out = await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5
      // tiny.en is English-only: do NOT pass language/task (model rejects them).
    });
    const timeSec = ((performance.now() - t0) / 1000).toFixed(1);
    const text = (out && out.text ? out.text : '').trim();
    log(`Transcribed in ${timeSec}s → "${text}"`);
    return { text, timeSec: parseFloat(timeSec) };
  }

  global.LocalEngine = {
    MODEL_ID,
    MODEL_SOURCES,
    load,
    transcribe,
    isLoaded: () => !!transcriber,
    chosenSource: () => chosen
  };
})(window);

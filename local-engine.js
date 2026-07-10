/* =========================================================================
 * local-engine.js  —  runs Whisper TINY.EN entirely in the browser.
 * No server, no API key, no cost. Audio never leaves the device.
 * Uses Transformers.js v3 with the WASM backend (works on GitHub Pages,
 * no SharedArrayBuffer / COOP-COEP required, and survives WeChat's
 * limited service-worker support).
 * ========================================================================= */
(function (global) {
  'use strict';

  // Everything self-hosted in THIS repo (no Hugging Face, no jsDelivr — GFW-safe).
  // Transformers.js treats the pipeline first arg as a HF repo *id* and always
  // builds an https://huggingface.co/<id>/... URL from it — it does NOT detect
  // full URLs. So we pass a plain id and point localModelPath at our directory.
  const MODEL_ID    = 'whisper-tiny.en';                 // repo-style id, not a URL
  const MODEL_DIR    = new URL('models/', location.href).href;   // …/models/  (parent of the model folder)
  const LIB_URL   = new URL('lib/transformers.min.js?v=4', location.href).href;
  const WASM_PATH   = new URL('lib/wasm/', location.href).href;  // trailing slash required
  let transcriber = null;     // cached pipeline
  let loading = null;          // in-flight promise

  function log(msg) { if (global.__speechLog) global.__speechLog(msg); }

  async function load(onProgress) {
    if (transcriber) return transcriber;
    if (loading) return loading;

    loading = (async () => {
      log('Engine: importing self-hosted transformers.js …');
      const { pipeline, env } = await import(LIB_URL);

      // Serve weights ONLY from THIS repo. localModelPath is joined with MODEL_ID
      // to form …/models/whisper-tiny.en/<file>, so the HF host is never contacted.
      env.allowLocalModels = true;
      env.allowRemoteModels = false;     // hard block any huggingface.co fallback
      env.localModelPath = MODEL_DIR;
      env.backends.onnx.wasm.proxy = false;
      env.backends.onnx.wasm.wasmPaths = WASM_PATH;

      log('Engine: loading self-hosted model ' + MODEL_ID + ' from ' + MODEL_DIR + ' (quantized, wasm) — first load ~41 MB …');
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
   * @param {Blob} wavBlob  16-bit PCM WAV
   * @returns {Promise<{text:string, timeSec:number}>}
   */
  async function transcribe(wavBlob) {
    if (!transcriber) await load();
    const t0 = performance.now();
    log('Transcribing audio (wasm) …');
    const out = await transcriber(wavBlob, {
      chunk_length_s: 30,
      stride_length_s: 5,
      language: 'english',
      task: 'transcribe'
    });
    const timeSec = ((performance.now() - t0) / 1000).toFixed(1);
    const text = (out && out.text ? out.text : '').trim();
    log(`Transcribed in ${timeSec}s → "${text}"`);
    return { text, timeSec: parseFloat(timeSec) };
  }

  global.LocalEngine = {
    MODEL_ID,
    MODEL_DIR,
    LIB_URL,
    WASM_PATH,
    load,
    transcribe,
    isLoaded: () => !!transcriber
  };
})(window);

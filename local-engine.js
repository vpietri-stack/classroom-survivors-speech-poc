/* =========================================================================
 * local-engine.js  —  runs Whisper TINY.EN entirely in the browser.
 * No server, no API key, no cost. Audio never leaves the device.
 * Uses Transformers.js v3 with the WASM backend (works on GitHub Pages,
 * no SharedArrayBuffer / COOP-COEP required, and survives WeChat's
 * limited service-worker support).
 * ========================================================================= */
(function (global) {
  'use strict';

  // Self-hosted model, committed to THIS repo (no Hugging Face, GFW-safe).
  // Files live under models/whisper-tiny.en/ and are served by GitHub Pages.
  // Resolve relative to the current page so it works on any GH-Pages subpath.
  const MODEL_URL = new URL('models/whisper-tiny.en/', location.href).href;
  let transcriber = null;     // cached pipeline
  let loading = null;          // in-flight promise

  function log(msg) { if (global.__speechLog) global.__speechLog(msg); }

  async function load(onProgress) {
    if (transcriber) return transcriber;
    if (loading) return loading;

    loading = (async () => {
      log('Engine: importing @huggingface/transformers …');
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3');

      // Load weights from THIS repo, not huggingface.co (blocked in China).
      env.allowLocalModels = false;
      env.backends.onnx.wasm.proxy = false;

      log('Engine: loading self-hosted model from ' + MODEL_URL + ' (quantized, wasm) — first load ~41 MB …');
      const pipe = await pipeline('automatic-speech-recognition', MODEL_URL, {
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
    MODEL_URL,
    load,
    transcribe,
    isLoaded: () => !!transcriber
  };
})(window);

/* =========================================================================
 * local-engine.js  —  runs Whisper TINY.EN entirely in the browser.
 * No server, no API key, no cost. Audio never leaves the device.
 * Uses Transformers.js v3 with the WASM backend (works on GitHub Pages,
 * no SharedArrayBuffer / COOP-COEP required, and survives WeChat's
 * limited service-worker support).
 * ========================================================================= */
(function (global) {
  'use strict';

  const MODEL_ID = 'onnx-community/whisper-tiny.en';
  let transcriber = null;     // cached pipeline
  let loading = null;          // in-flight promise

  function log(msg) { if (global.__speechLog) global.__speechLog(msg); }

  async function load(onProgress) {
    if (transcriber) return transcriber;
    if (loading) return loading;

    loading = (async () => {
      log('Engine: importing @huggingface/transformers …');
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3');

      // Keep all model files on jsDelivr (github-hosted, GFW-accessible).
      env.allowLocalModels = false;

      log('Engine: loading ' + MODEL_ID + ' (q8, wasm) — first load ~78 MB …');
      const pipe = await pipeline('automatic-speech-recognition', MODEL_ID, {
        device: 'wasm',
        dtype: 'q8',
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
    load,
    transcribe,
    isLoaded: () => !!transcriber
  };
})(window);

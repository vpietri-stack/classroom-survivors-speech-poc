/* =========================================================================
 * app.js  —  UI glue for the PoC.
 *  • environment capability check (mic / browser)
 *  • model load button
 *  • per-exercise record → transcribe → score → pass/fail
 *  • free-speak diagnostic to stress-test Whisper accuracy on real accents
 * ========================================================================= */
(function () {
  'use strict';

  // ---- exercises (replace with your real word/sentence decks later) --------
  const EXERCISES = [
    { type: 'word', text: 'apple' },
    { type: 'word', text: 'teacher' },
    { type: 'word', text: 'triangle' },
    { type: 'sentence', text: 'the weather is nice today' },
    { type: 'sentence', text: 'i would like a glass of water' },
    { type: 'sentence', text: 'she sells sea shells by the sea shore' }
  ];

  // ---- logging -------------------------------------------------------------
  const statusEl = document.getElementById('status');
  window.__speechLog = (msg) => {
    const ts = new Date().toLocaleTimeString();
    statusEl.textContent += `[${ts}] ${msg}\n`;
    statusEl.scrollTop = statusEl.scrollHeight;
  };
  const log = window.__speechLog;

  // ---- environment capability check ----------------------------------------
  function checkEnv() {
    const el = document.getElementById('env');
    const ua = navigator.userAgent;
    const isWeChat = /MicroMessenger/i.test(ua);
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const micOK = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

    let html = '';
    html += `<div class="mb-1">🎙️ Microphone API: <b>${micOK ? 'available' : 'MISSING'}</b></div>`;
    html += `<div class="mb-1">🌐 Browser: ${isWeChat ? 'WeChat in-app' : (isIOS ? 'iOS Safari/WebView' : 'other')}</div>`;

    if (isWeChat && isIOS) {
      html += `<div class="text-red-600 font-semibold mt-2">⚠️ iOS + WeChat in-app browser: mic capture is unreliable.
        Please open this page in Safari ("…" → 在Safari中打开) for speech to work.</div>`;
    } else if (isWeChat) {
      html += `<div class="text-amber-600 mt-1">ℹ️ WeChat in-app: mic usually works on Android; if it fails, open in the system browser.</div>`;
    } else {
      html += `<div class="text-green-600 mt-1">✅ This browser should support mic capture.</div>`;
    }
    el.innerHTML = html;
    if (!micOK) document.getElementById('loadBtn').disabled = true;
  }

  // ---- build exercise cards ------------------------------------------------
  const exRoot = document.getElementById('exercises');
  function buildCards() {
    EXERCISES.forEach((ex, i) => {
      const card = document.createElement('div');
      card.className = 'word-card pending bg-white rounded-xl p-3 flex items-center gap-3 shadow-sm';
      card.innerHTML = `
        <span class="text-xs uppercase tracking-wide text-slate-400 w-14">${ex.type}</span>
        <span class="text-lg font-semibold flex-1">${ex.text}</span>
        <button class="recBtn bg-red-500 hover:bg-red-600 text-white rounded-lg w-11 h-11 text-lg shrink-0" data-i="${i}">●</button>
        <span class="result text-sm text-slate-600 w-40 truncate"></span>
        <span class="judge text-sm font-bold w-10 text-center"></span>
      `;
      exRoot.appendChild(card);
      const btn = card.querySelector('.recBtn');
      const resultEl = card.querySelector('.result');
      const judgeEl = card.querySelector('.judge');
      btn.addEventListener('click', () => onRecord(ex, btn, resultEl, judgeEl, card));
    });
  }

  // ---- record → transcribe → score ----------------------------------------
  const recorder = new Recorder();
  let busy = false;

  async function onRecord(ex, btn, resultEl, judgeEl, card) {
    if (busy) return;
    if (!LocalEngine.isLoaded()) {
      log('Model not loaded yet — click "Load model" first.');
      return;
    }
    busy = true;
    try {
      if (btn.dataset.on === '1') {
        // stop
        btn.dataset.on = '0';
        btn.classList.remove('bg-red-600'); btn.textContent = '●';
        resultEl.textContent = '…';
        const wav = await recorder.stop();
        const { text } = await LocalEngine.transcribe(wav);
        const level = parseInt(document.getElementById('level').value, 10);
        const r = Scorer.score(ex.text, text, level);
        resultEl.textContent = text || '(silence / unclear)';
        judgeEl.textContent = r.pass ? '✅' : '❌';
        card.classList.toggle('correct', r.pass);
        card.classList.toggle('wrong', !r.pass);
        log(`Score "${ex.text}" @ L${level}: pass=${r.pass} | ${r.details}`);
      } else {
        // start
        btn.dataset.on = '1';
        btn.classList.add('bg-red-600'); btn.textContent = '■';
        resultEl.textContent = 'listening…'; judgeEl.textContent = '';
        card.classList.remove('correct', 'wrong');
        await recorder.start();
      }
    } catch (e) {
      log('ERROR: ' + (e && e.message ? e.message : e));
      btn.dataset.on = '0'; btn.textContent = '●';
      resultEl.textContent = 'error';
    } finally {
      busy = false;
    }
  }

  // ---- free-speak diagnostic ----------------------------------------------
  document.getElementById('freeTestBtn').addEventListener('click', async () => {
    if (busy) return;
    if (!LocalEngine.isLoaded()) { log('Load the model first.'); return; }
    busy = true;
    try {
      log('Free-speak: recording…');
      await recorder.start();
      setTimeout(async () => {
        try {
          const wav = await recorder.stop();
          const { text, timeSec } = await LocalEngine.transcribe(wav);
          log(`FREE-SPEAK result (${timeSec}s): "${text}"`);
        } catch (e) {
          log('FREE-SPEAK ERROR: ' + (e && e.message ? e.message : e));
        } finally {
          busy = false;
        }
      }, 4000);
    } catch (e) {
      log('ERROR: ' + (e && e.message ? e.message : e));
      busy = false;
    }
  });

  document.getElementById('clearLog').addEventListener('click', () => { statusEl.textContent = ''; });

  // ---- model load ----------------------------------------------------------
  const loadBtn = document.getElementById('loadBtn');
  const modelStatus = document.getElementById('modelStatus');
  loadBtn.addEventListener('click', async () => {
    loadBtn.disabled = true;
    try {
      await LocalEngine.load((pct, file) => {
        modelStatus.textContent = `Loading… ${pct}%  ${file}`;
      });
      modelStatus.textContent = 'Loaded ✅';
    } catch (e) {
      modelStatus.textContent = 'FAILED — see log';
      log('LOAD ERROR: ' + (e && e.message ? e.message : e));
      loadBtn.disabled = false;
    }
  });

  // ---- init ----------------------------------------------------------------
  checkEnv();
  buildCards();
  log('PoC ready. Click "Load model", then a red ● to record.');
})();

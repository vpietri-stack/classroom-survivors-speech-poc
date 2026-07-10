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
        <button class="recBtn bg-red-500 hover:bg-red-600 active:bg-red-700 text-white rounded-lg w-11 h-11 text-lg shrink-0 touch-none select-none cursor-pointer" data-i="${i}">●</button>
        <span class="result text-sm text-slate-600 w-40 truncate"></span>
        <span class="judge text-sm font-bold w-10 text-center"></span>
      `;
      exRoot.appendChild(card);
      const btn = card.querySelector('.recBtn');
      const resultEl = card.querySelector('.result');
      const judgeEl = card.querySelector('.judge');
      btn.addEventListener('pointerdown', (ev) => {
        if (!LocalEngine.isLoaded()) { log('Model not loaded yet — click "Load model" first.'); return; }
        ev.preventDefault();
        try { btn.setPointerCapture(ev.pointerId); } catch (_) {}
        onRecordStart(ex, btn, resultEl, judgeEl, card);
      });
      const end = (ev) => { ev.preventDefault(); onRecordEnd(ex, btn, resultEl, judgeEl, card); };
      btn.addEventListener('pointerup', end);
      btn.addEventListener('pointercancel', end);
      // Safety: if the pointer somehow leaves the button while captured, end on leave too.
      btn.addEventListener('lostpointercapture', () => onRecordEnd(ex, btn, resultEl, judgeEl, card));
    });
  }

  // ---- record (WeChat-style: hold to talk, release to send) ----------------
  const recorder = new Recorder();
  let busy = false;
  let holding = false;          // a press is in progress
  let startPending = false;     // pointerdown fired but getUserMedia still resolving

  // ---- recording overlay (freeze screen + live "listening" bubble) ---------
  const overlay = document.getElementById('recOverlay');
  const micEl = document.getElementById('recMic');
  const bars = Array.from(document.querySelectorAll('#recBars span'));
  let rafId = null;
  function animateOverlay() {
    const lvl = recorder.level || 0;                     // 0..1 live RMS
    micEl.style.transform = `scale(${1 + lvl * 0.6})`;   // mic pulses with voice
    for (let i = 0; i < bars.length; i++) {
      // center bars react most; add jitter so it looks alive even at steady volume
      const weight = 1 - Math.abs(i - (bars.length - 1) / 2) / bars.length;
      const h = 6 + lvl * 28 * weight * (0.7 + Math.random() * 0.6);
      bars[i].style.height = Math.min(34, h) + 'px';
    }
    rafId = requestAnimationFrame(animateOverlay);
  }
  function showOverlay() {
    overlay.classList.add('show');
    if (!rafId) rafId = requestAnimationFrame(animateOverlay);
  }
  function hideOverlay() {
    overlay.classList.remove('show');
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    bars.forEach(b => b.style.height = '6px');
    micEl.style.transform = 'scale(1)';
  }

  async function onRecordStart(ex, btn, resultEl, judgeEl, card) {
    if (busy || holding || startPending) return;
    holding = true;
    startPending = true;
    btn.classList.add('bg-red-700'); btn.textContent = '■';
    resultEl.textContent = 'release to send…'; judgeEl.textContent = '';
    card.classList.remove('correct', 'wrong');
    try {
      await recorder.start();   // may take a moment (getUserMedia prompt)
    } catch (e) {
      holding = false; startPending = false;
      hideOverlay();
      btn.classList.remove('bg-red-700'); btn.textContent = '●';
      resultEl.textContent = 'error';
      log('ERROR: ' + (e && e.message ? e.message : e));
      return;
    }
    startPending = false;
    if (!holding) {             // released during the async gap → discard
      hideOverlay();
      await safeStop(btn, resultEl);
      return;
    }
    showOverlay();             // mic is live → freeze screen + show listening bubble
  }

  async function safeStop(btn, resultEl) {
    let wav = null;
    try { wav = await recorder.stop(); } catch (_) {}
    return wav;
  }

  async function onRecordEnd(ex, btn, resultEl, judgeEl, card) {
    if (busy) { holding = false; return; }       // a previous job still running; ignore
    if (!holding) return;                          // stray release (e.g. before start resolved handled in start)
    if (startPending) { holding = false; return; } // released before mic ready → handled in onRecordStart
    holding = false;
    hideOverlay();             // release → unfreeze screen
    btn.classList.remove('bg-red-700'); btn.textContent = '●';
    resultEl.textContent = '…';
    busy = true;
    try {
      const wav = await safeStop(btn, resultEl);
      const { text } = await LocalEngine.transcribe(wav);
      const level = parseInt(document.getElementById('level').value, 10);
      const r = Scorer.score(ex.text, text, level);
      resultEl.textContent = text || '(silence / unclear)';
      judgeEl.textContent = r.pass ? '✅' : '❌';
      card.classList.toggle('correct', r.pass);
      card.classList.toggle('wrong', !r.pass);
      log(`Score "${ex.text}" @ L${level}: pass=${r.pass} | ${r.details}`);
    } catch (e) {
      log('ERROR: ' + (e && e.message ? e.message : e));
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
        modelStatus.textContent = pct >= 100
          ? 'Preparing model (compiling on device, ~30–60s)…'
          : `Loading… ${pct}%  ${file}`;
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

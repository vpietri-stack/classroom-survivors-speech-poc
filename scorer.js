/* =========================================================================
 * scorer.js  —  the "margin of error" engine.
 * Takes a target string + recognized transcript + a student level (1..5)
 * and returns { pass, accuracy, details }.
 *
 * Pure client-side, no dependencies. You control difficulty per level here.
 * Swapping the recognition engine (Whisper / Vosk / future Xunfei relay)
 * does NOT change this module.
 * ========================================================================= */
(function (global) {
  'use strict';

  // --- per-level tolerance -------------------------------------------------
  //  wordEdits   : max token-level edits allowed on the whole utterance
  //  minAccuracy : char-similarity floor before any phonetic leniency
  //  allowPhonetic: permit fuzzy single-word matches (L1 accent tolerance)
  //  exact       : if true, requires exact (case/punct-insensitive) match
  const LEVELS = {
    1: { label: 'Level 1 (beginner)',      wordEdits: 3, minAccuracy: 0.50, allowPhonetic: true,  exact: false },
    2: { label: 'Level 2 (elementary)',    wordEdits: 2, minAccuracy: 0.65, allowPhonetic: true,  exact: false },
    3: { label: 'Level 3 (intermediate)',  wordEdits: 1, minAccuracy: 0.80, allowPhonetic: true,  exact: false },
    4: { label: 'Level 4 (upper-inter)',   wordEdits: 1, minAccuracy: 0.92, allowPhonetic: false, exact: false },
    5: { label: 'Level 5 (advanced)',      wordEdits: 0, minAccuracy: 1.00, allowPhonetic: false, exact: true  }
  };

  function normalize(s) {
    return (s || '')
      .toLowerCase()
      .replace(/[.,!?;:'"()\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
    return dp[m][n];
  }

  // Char-level similarity of the two (normalized) utterances.
  // One formula handles BOTH single words and whole sentences.
  function accuracyOf(tgt, got) {
    if (!tgt && !got) return 1;
    if (!tgt || !got) return 0;
    const d = levenshtein(tgt, got);
    const denom = Math.max(tgt.length, got.length, 1);
    return Math.max(0, 1 - d / denom);
  }

  // Fuzzy single-word matcher. Captures L1-Chinese confusions naturally via
  // character distance, e.g. light~right (1/5), very~wery (1/5),
  // three~tree (1/5), teacher~teacha (2/7) — while rejecting apple~banana.
  const WORD_FUZZY = 1 / 3; // up to 1/3 of chars may differ
  function phoneticMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const d = levenshtein(a, b);
    const denom = Math.max(a.length, b.length, 1);
    return d / denom <= WORD_FUZZY;
  }

  /**
   * @param {string} target      e.g. "the weather is nice today"
   * @param {string} transcript  what the STT heard
   * @param {number} level       1..5
   */
  function score(target, transcript, level) {
    const cfg = LEVELS[level] || LEVELS[3];
    const tgt = normalize(target);
    const got = normalize(transcript);
    const tTok = tgt ? tgt.split(' ') : [];
    const gTok = got ? got.split(' ') : [];

    if (cfg.exact) {
      const pass = tgt === got;
      return { pass, accuracy: pass ? 1 : 0, details: pass ? 'exact match' : 'exact match required', cfg };
    }

    // exact normalized match -> instant pass
    if (tgt && tgt === got) {
      return { pass: true, accuracy: 1, details: 'exact match', cfg };
    }

    const accuracy = accuracyOf(tgt, got);

    // word-level phonetic leniency (ALTERNATIVE path): a target word is
    // "phonetically covered" if ANY recognized token is a fuzzy match.
    // Evaluated even when edit-distance accuracy is low, so heavily accented
    // but phonetically-close single words still pass at low levels.
    let phoneticHits = 0;
    if (cfg.allowPhonetic && tTok.length && gTok.length) {
      for (const tw of tTok) {
        if (gTok.some(gw => phoneticMatch(tw, gw))) phoneticHits++;
      }
    }
    const phoneticRatio = tTok.length ? phoneticHits / tTok.length : 0;

    // decide — accuracy path OR phonetic path (whichever passes)
    const edits = levenshtein(tTok.join(' '), gTok.join(' '));
    let pass = false, details = '';

    const accuracyOk = accuracy >= cfg.minAccuracy && edits <= cfg.wordEdits;
    const phoneticOk = cfg.allowPhonetic && phoneticRatio >= 0.8;

    if (accuracyOk) {
      pass = true;
      details = `accuracy ${(accuracy * 100).toFixed(0)}% (≤${cfg.wordEdits} edits allowed)`;
    } else if (phoneticOk) {
      pass = true;
      details = `phonetic match ${(phoneticRatio * 100).toFixed(0)}% (accent tolerant)`;
    } else {
      const reasons = [];
      if (accuracy < cfg.minAccuracy) reasons.push(`accuracy ${(accuracy * 100).toFixed(0)}% < ${(cfg.minAccuracy * 100).toFixed(0)}%`);
      if (edits > cfg.wordEdits) reasons.push(`${edits} edits > ${cfg.wordEdits}`);
      if (cfg.allowPhonetic && phoneticRatio < 0.8) reasons.push(`phonetic ${(phoneticRatio * 100).toFixed(0)}% < 80%`);
      details = reasons.join('; ');
    }

    return { pass, accuracy, details, phoneticRatio, edits, cfg };
  }

  global.Scorer = { score, LEVELS, normalize, phoneticMatch, levenshtein };
})(window);

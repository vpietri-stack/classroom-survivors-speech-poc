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

  // --- per-level tolerance ------------------------------------------------
  // wordFuzzy : allow fuzzy (phonetic) single-word matching at this level
  // wordEdits : max Levenshtein edits allowed on the whole token sequence
  // minAccuracy: hard floor on accuracy % before any phonetic leniency
  // exact     : if true, requires exact (case/punct-insensitive) match
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

  // Minimal Double-Metaphone-ish English phonizer (educational, not exhaustive).
  // Good enough to treat common L1-Chinese confusions as "close":
  //   l/r, v/w, th/s, f/v, s/sh, etc.
  function metaphone(word) {
    word = (word || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!word) return '';
    // collapse repeated letters
    word = word.replace(/(.)\1+/g, '$1');
    // common substitutes
    word = word
      .replace(/ph/g, 'f')
      .replace(/([^l])r(?![aeiou])/g, '$1l')   // final/ambient r -> l
      .replace(/^r/, 'l')                        // initial r -> l (L1-CN)
      .replace(/w/g, 'v')                        // w -> v
      .replace(/v/g, 'f')                        // v -> f
      .replace(/th/g, 's')                       // think -> sink
      .replace(/sh/g, 's')
      .replace(/ch/g, 'c')
      .replace(/[aeiou]+/g, '');                 // drop vowels
    return word;
  }

  function phoneticMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return metaphone(a) === metaphone(b);
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

  function accuracyOf(targetTokens, gotTokens) {
    // token-level edit distance as a fraction of target length
    const d = levenshtein(targetTokens.join(' '), gotTokens.join(' '));
    const denom = Math.max(targetTokens.length, gotTokens.length, 1);
    return Math.max(0, 1 - d / denom);
  }

  /**
   * @param {string} target  e.g. "the weather is nice"
   * @param {string} transcript  what the STT heard
   * @param {number} level  1..5
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

    // 1) exact normalized match -> instant pass
    if (tgt && tgt === got) {
      return { pass: true, accuracy: 1, details: 'exact match', cfg };
    }

    const accuracy = accuracyOf(tTok, gTok);

    // 2) word-level phonetic leniency (for single words or per-word)
    let phoneticHits = 0;
    if (cfg.allowPhonetic && tTok.length && gTok.length) {
      // align by index for short items; good enough for words/sentences practice
      for (let i = 0; i < tTok.length; i++) {
        const tw = tTok[i];
        // look for a phonetic match anywhere in the recognized tokens
        if (gTok.some(gw => phoneticMatch(tw, gw))) phoneticHits++;
      }
    }
    const phoneticRatio = tTok.length ? phoneticHits / tTok.length : 0;

    // 3) decide
    const edits = levenshtein(tTok.join(' '), gTok.join(' '));
    let pass = false, details = '';
    if (accuracy >= cfg.minAccuracy) {
      // meet the accuracy floor
      if (edits <= cfg.wordEdits) {
        pass = true;
        details = `accuracy ${(accuracy * 100).toFixed(0)}% (≤${cfg.wordEdits} edits allowed)`;
      } else {
        details = `accuracy OK (${(accuracy * 100).toFixed(0)}%) but ${edits} edits > allowed ${cfg.wordEdits}`;
      }
    } else if (cfg.allowPhonetic && phoneticRatio >= 0.8) {
      // heavily accented but phonetically close -> lenient pass for low levels
      pass = true;
      details = `phonetic match ${(phoneticRatio * 100).toFixed(0)}% (accent tolerant)`;
    } else {
      details = `accuracy ${(accuracy * 100).toFixed(0)}% < required ${(cfg.minAccuracy * 100).toFixed(0)}%`;
    }

    return { pass, accuracy, details, phoneticRatio, edits, cfg };
  }

  global.Scorer = { score, LEVELS, normalize, metaphone, phoneticMatch };
})(window);

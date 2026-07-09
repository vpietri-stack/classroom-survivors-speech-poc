# Classroom Survivors — Speech PoC (in-browser Whisper)

A **zero-cost, fully local** proof-of-concept for adding "speaking" to the ESL app.
Speech recognition runs **entirely in the student's browser** via
[Transformers.js](https://huggingface.co/docs/transformers.js) + `whisper-tiny.en`.
**No server, no API key, no paid account.** Audio never leaves the device — so it
bypasses the GFW entirely and adds zero load to your Azure DB.

## What this PoC tests

1. **Capture** — can we reliably record the mic in your users' real browsers
   (WeChat in-app, iOS Safari, Android local browsers)?
2. **Accuracy** — how well does `whisper-tiny.en` transcribe **L1-Chinese
   accented** English? This is the big unknown to validate before committing.
3. **Margin of error** — the `Scorer` module grades transcripts against a target
   word/sentence with a **per-level tolerance** you control (Level 1 lenient →
   Level 5 near-perfect). This logic is engine-agnostic, so swapping to a paid
   Xunfei relay later changes nothing here.

## Files

| File | Role |
|---|---|
| `index.html` | UI (vanilla JS, Tailwind via CDN — matches Classroom-survivors conventions) |
| `recorder.js` | Mic capture → 16 kHz / 16-bit mono WAV (Safari/Android/WeChat-safe) |
| `local-engine.js` | Loads + runs Whisper tiny.en in-browser (WASM backend, no SAB) |
| `scorer.js` | The "margin of error": normalize → edit distance → phonetic tolerance → per-level pass |
| `app.js` | UI glue: model load, per-exercise record→transcribe→score, free-speak diagnostic |

## Run it locally (for desktop testing)

Because `getUserMedia` requires a secure context, use `localhost` (HTTPS-equivalent):

```bash
# from this folder
python3 -m http.server 8000
# open http://localhost:8000
```

Then click **Load model** (first load downloads ~78 MB, then it's cached),
pick a level, and press a red ● to record a word/sentence.

## Publish as a GitHub Page (to test on real phones in China)

```bash
git init
git add -A
git commit -m "Speech PoC: in-browser whisper-tiny.en + per-level scorer"
gh repo create classroom-survivors-speech-poc --public --source=. --push
# OR if you already made the repo:
#   git remote add origin https://github.com/YOURUSER/classroom-survivors-speech-poc.git
#   git branch -M main && git push -u origin main
```

Enable Pages: **Repo → Settings → Pages → Source: Deploy from a branch → `main` → `/(root)`**.
GitHub serves over HTTPS, so `getUserMedia` works on phones too.

> Note: the Whisper model + Transformers.js load from `cdn.jsdelivr.net`, which is
> generally accessible inside mainland China. If you later find it blocked on some
> school networks, mirror those assets to the repo (or a domestic CDN) and point
> `env`/`import` at them — no code change needed in the capture/scorer logic.

## Tuning the "margin of error"

Edit `LEVELS` in `scorer.js`:

```js
1: { wordEdits: 3, minAccuracy: 0.50, allowPhonetic: true,  exact: false }, // beginners
5: { wordEdits: 0, minAccuracy: 1.00, allowPhonetic: false, exact: true  }, // advanced
```

`allowPhonetic` uses a small English phonizer so L1-Chinese confusions
(l↔r, v↔w, th↔s) still pass at low levels but not high ones.

## Known limitations (be honest about these)

- **Tiny model** → lower accuracy than base/large, especially on heavy accents and
  isolated single words. Validate with real student audio first.
- **No pronunciation fidelity** — STT transcribes; it can't judge *how* a word
  sounded (homophones like ship/sheep may false-pass). A future paid Xunfei relay
  would add that; the Scorer stays the same.
- **WeChat in-app on iOS**: mic capture is unreliable — the UI detects this and
  prompts "open in Safari". Plan a text fallback in the real app.
- **~78 MB** first-load download per device (cached afterward).

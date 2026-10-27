---
"@titan-design/explainer": patch
---

The qa stage checks the render's caption track against words.json and reports five checks without gating on them: `captions-complete` (the VTT exists, has the WEBVTT header and has cues for narrated words), `captions-words` (cue words equal words.json's, ignoring case and punctuation), `captions-lines` (at most 2 lines of 42 characters), `captions-cps` (at most 20 characters a second) and `captions-onset` (each cue starts within 0.3 s of its first word). `CAPTIONS_GATE` in `qa/gate-profile.ts` turns all five into gates. qa reads `vtt` as an optional input; the qa stage version moves to x10i.

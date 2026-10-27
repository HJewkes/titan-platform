---
"@titan-design/explainer": patch
---

The qa stage gates on three on-screen word checks instead of reporting them: G9 (a headline holds at most 10 words, a label at most 3, as the `headline-label-words` check), G10 (no display text repeats a run of 5 or more of its beat's narration words, as `narration-shared-run`) and a new `words-per-frame` gate (at most 20 prose words on screen together at any sampled moment; `pre` and `code` text is not counted). A failing one fails qa.json's `pass` and the stage. The qa stage version moves to x10g.

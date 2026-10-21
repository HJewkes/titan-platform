---
"@titan-design/explainer": minor
---

Add `guardBeat`, the per-beat guard for the voice rewrite pass (TP-3817). It rejects a rewrite that drops or reorders a cue, loses a new term, invents a number, or removes a number without carrying it verbatim in an appended label, and it enforces the sentence cap with an optional speech verdict. Also exports `numberSpans` and `overlongSentence`.

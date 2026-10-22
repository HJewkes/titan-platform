---
"@titan-design/explainer": minor
---

Add the first pieces of the voice rewrite pass. `numberSpans` and `triadSpans` return the spans the register rows count. `planRegisterEdits` turns failing register rows into per-beat directives: number mentions, lists of three, and a sentence shape planned under the vetted cap, plus a round-2 call that only fixes the numbers and triads left after round 1. `renderRewritePrompt` renders one chapter's prompt from the new `doctrine/guides/rewrite-v0.md`.

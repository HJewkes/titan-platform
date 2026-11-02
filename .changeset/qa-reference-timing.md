---
"@titan-design/explainer": patch
---

The qa stage reports two temporal-contiguity timing checks in qa.json's timing gates, without gating on them: `early-reveal` (no text element holding a cue's word shows more than one sentence before that word is said) and `hold-through-reference` (a text element stays on screen until half a second past the last word of its beat's narration that names it). The qa stage version moves to x10h.

---
"@titan-design/explainer": patch
---

The qa stage reports `narration-facts`: each number a beat shows on screen and each name its headline claims must be heard in that beat's narration. Spoken and written forms count as one value ("40%" is "forty percent", "1.2k" is "twelve hundred"), and a value rounded to two significant figures counts as said. Axis ends, step markers, beat and item numbers, citations, and years outside a headline are left out. A chart counts only its largest value. The check reports and does not gate; `NARRATION_FACTS_GATE` in `qa/gate-profile.ts` makes it a gate. The qa stage version moves to x10j. L1-cold now takes `assertions` (script/v1 `visual.assertion` by beat) and asks, for each beat, which spoken words carry the on-screen claim. Those scores are recorded under kind `assertion` and are not counted in `undefined_items`.

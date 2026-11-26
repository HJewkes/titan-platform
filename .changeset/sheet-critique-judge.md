---
"@titan-design/explainer": minor
---

Add `runSheetCritique`, the image judge for contact sheets (TP-5886). It runs the four critique passes in a fixed order with every chapter sheet attached, voids and counts any finding that names no cell in `cells.json`, and sends a fifth canary call with a planted glow still. A run whose judge misses the glow is marked untrusted. The surviving findings feed `critiqueScore`. `SHEET_JUDGE` is claude-print opus with `max_budget_usd` 0.5 per call, and the run refuses a judge that is the script model. The rubric is `rubrics/sheet-critique.md`. `CAP_TAGS` is now exported.

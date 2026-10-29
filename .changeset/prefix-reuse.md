---
"@titan-design/session-analytics": minor
---

`prefixReuse(rows, { windowMin })` reports first-call cache-read share, input spend at list price, a simulated system-prompt hit rate within the window, and the pairwise first divergence of requests by block; `firstDivergence` compares two requests. `scripts/prefix-report.mjs` prints it over recent transcripts.

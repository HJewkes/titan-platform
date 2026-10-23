---
"@titan-design/explainer": minor
---

Add `gatherPr`, the pr-overview profile's gather stage body: it writes `facts.jsonl` from a PR's diff, its reviews and comments, and the code-graph calls between its changed files at the head commit, with content-derived fact ids and coded refusals (`PR_GATHER_CODES`). Add `explainer pr gather` (on request) and `explainer pr trigger [--dry-run]`, which starts a decision-brief only for PRs Shepherd holds at the owner's visual gate (`visual-gate2`). The explainer now depends on `@titan-design/code-graph`.

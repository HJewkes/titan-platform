---
"@titan-design/evals": patch
---

Add `src/history/label-v2.ts`, a port of the eval corpus label v2 rule (rework commits, prior attempts, follow-up fixes, reverts, outcome, exclusions and the pinned window), an offline `gh-cache` reader that never fetches, and `v2Parity`, which lists each stored case and label field the port disagrees on (TP-949 slice d). Not wired into the CLI yet.

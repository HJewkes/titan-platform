---
"@titan-design/session-graph": patch
---

`RECONCILE_PR_MERGES` no longer overwrites `merged_at` once a PR's outcome has been forge-checked (TP-310); a transcript sighting time can no longer clobber a forge-accurate merge time on a later rollup pass.

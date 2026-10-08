---
"@titan-design/factory": patch
---

A Shepherd merge whose evidence read `mergeable_state` as `unknown` on all three reads no longer opens approve-merge at once. The land core records a `merge-settle` step and waits with backoff (0 s, 30 s, 60 s, 120 s, then 180 s). It re-reads CI, then reads the merge evidence again at the same head and decides again. A head push during the wait restarts the wait at the new head. The first-unknown time is stored in the step record, so a restart or replay keeps it. A blocking state gates at once. After 30 minutes at one head the gate opens. Its reason names how many minutes the head was unsettled and the result of a local `git merge-tree` of the head onto the base tip.

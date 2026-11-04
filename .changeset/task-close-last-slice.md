---
"@titan-design/factory": minor
"@titan-design/coordinator": minor
---

Shepherd: `shepherd.taskClose` picks when a merged PR closes its `--task` (TP-4274). `keep`, the default when absent, closes it on every merge as before. `last-slice-only` closes it only on the last slice: a `Last slice: yes` line in the PR body, `shepherd register --last-slice`, or no other open PR registered with the same task and no `Last slice: no` line. Otherwise the task stays open and gains a `slice merged: <owner/repo>#<n> at <sha>` note. Migration 43 adds the registration's `last_slice` column. The coordinator adds `shepherd.taskClose` as a live editable factory row.

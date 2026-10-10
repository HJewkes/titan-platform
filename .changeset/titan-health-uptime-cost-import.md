---
"@titan-design/titan": minor
---

Add `titan health uptime`, `cost` and `import`. `uptime <target> --window 24h [--end] [--min] [--json]` reads the store read-only and reports up, down, unknown and missing slots, both up shares, the gaps (longest first in text), and the restart and unclean-start deltas of serve's own `/health` counters, flagging a counter that dropped as `counterReset` instead of a negative delta; `--min` exits 1 below the share. `cost` folds the sampler's self rows into ticks with mean and max wall time, CPU, fs blocks and context switches per tick, max RSS and the store size. `import <jsonl>` maps the shepherd-health stopgap rows to samples keyed by file name and raw line, so a re-import adds nothing; bad lines are counted and skipped.

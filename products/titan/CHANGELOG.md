# @titan-design/titan

## 0.1.0

### Minor Changes

- 397c086: Add `titan health install [--dry-run]` and `titan health uninstall`. Install renders the `titan-health-sample` oneshot service (Nice 10, idle IO, CPU and IO accounting) and its minutely timer (`AccuracySec=1s`, not persistent) into the systemd user directory, with `ExecStart` calling node and the titan bin by absolute path, then runs `daemon-reload` and `enable --now` on the timer. Uninstall disables the timer, removes both units and reloads. Both exit 2 on any platform but Linux.
- 1ae0cd9: Add the titan host CLI with `titan health sample`. One tick probes every target in parallel (by default the factory's loopback `/health`, with its pid file as identity and serve's restart counters copied into `observed`), adds a `self` row with the sampler's own CPU, fs blocks, context switches, max RSS and wall time, and stores all rows in one `appendSamples` call.
- b68d5a4: Add `titan health uptime`, `cost` and `import`. `uptime <target> --window 24h [--end] [--min] [--json]` reads the store read-only and reports up, down, unknown and missing slots, both up shares, the gaps (longest first in text), and the restart and unclean-start deltas of serve's own `/health` counters, flagging a counter that dropped as `counterReset` instead of a negative delta; `--min` exits 1 below the share. `cost` folds the sampler's self rows into ticks with mean and max wall time, CPU, fs blocks and context switches per tick, max RSS and the store size. `import <jsonl>` maps the shepherd-health stopgap rows to samples keyed by file name and raw line, so a re-import adds nothing; bad lines are counted and skipped.

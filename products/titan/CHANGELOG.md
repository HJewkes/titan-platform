# @titan-design/titan

## 0.4.1

### Patch Changes

- 12f75a6: Health target merging and the cost report build their results without type assertions. No behaviour change.
- 5390a34: titan imports the systemd escaping, PATH, unit-directory and node-path helpers from `@titan-design/daemon/service` and deletes its own copies. Rendered unit files are byte-identical, except that a node directory containing ":" now throws instead of writing a broken PATH.
- Updated dependencies [1ac0fa2]
- Updated dependencies [24f1577]
- Updated dependencies [6554538]
- Updated dependencies [c525f57]
- Updated dependencies [9dd8d1c]
- Updated dependencies [9b42150]
- Updated dependencies [00fb3ee]
- Updated dependencies [147ff5d]
  - @titan-design/daemon@0.9.0
  - @titan-design/health@0.2.1

## 0.4.0

### Minor Changes

- 336eeb1: Add `titan config report`: this host's config surfaces as file facts (present, mode, mtime, and size and sha256 for files that are not secret), never their values. `--to` deposits the report in the console's `config.report` over the LAN bearer.

## 0.3.2

### Patch Changes

- Updated dependencies [9b5d49f]
  - @titan-design/daemon@0.8.0

## 0.3.1

### Patch Changes

- f8acaee: Extract the systemd unit quoting helpers and the oneshot service and calendar timer renderers from
  the health sampler units into a shared `systemd/render` module, so host services can render their
  units the same way. The health sampler units render byte-identical output.
- Updated dependencies [448bcea]
- Updated dependencies [3fafd2e]
- Updated dependencies [8f37474]
  - @titan-design/daemon@0.7.0

## 0.3.0

### Minor Changes

- 6de2539: `titan host doctor` adds an `inventory` row group: a stat-only presence row for every path in
  the coordination design's section 2 inventory on the current platform, so secrets are checked
  without being read.

## 0.2.0

### Minor Changes

- 2c309ee: Add `titan host doctor [--json]`: runs the active-work, agent-chat and titan-factory doctors and
  reports presence and version for the product and tool CLIs, warning when a linked product CLI's
  version differs from its checkout's package.json.

## 0.1.0

### Minor Changes

- 397c086: Add `titan health install [--dry-run]` and `titan health uninstall`. Install renders the `titan-health-sample` oneshot service (Nice 10, idle IO, CPU and IO accounting) and its minutely timer (`AccuracySec=1s`, not persistent) into the systemd user directory, with `ExecStart` calling node and the titan bin by absolute path, then runs `daemon-reload` and `enable --now` on the timer. Uninstall disables the timer, removes both units and reloads. Both exit 2 on any platform but Linux.
- 1ae0cd9: Add the titan host CLI with `titan health sample`. One tick probes every target in parallel (by default the factory's loopback `/health`, with its pid file as identity and serve's restart counters copied into `observed`), adds a `self` row with the sampler's own CPU, fs blocks, context switches, max RSS and wall time, and stores all rows in one `appendSamples` call.
- b68d5a4: Add `titan health uptime`, `cost` and `import`. `uptime <target> --window 24h [--end] [--min] [--json]` reads the store read-only and reports up, down, unknown and missing slots, both up shares, the gaps (longest first in text), and the restart and unclean-start deltas of serve's own `/health` counters, flagging a counter that dropped as `counterReset` instead of a negative delta; `--min` exits 1 below the share. `cost` folds the sampler's self rows into ticks with mean and max wall time, CPU, fs blocks and context switches per tick, max RSS and the store size. `import <jsonl>` maps the shepherd-health stopgap rows to samples keyed by file name and raw line, so a re-import adds nothing; bad lines are counted and skipped.

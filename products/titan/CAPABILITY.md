# titan: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You want this host's services sampled on a schedule and kept: `titan health sample` probes each target (by default the factory's loopback `/health`, with its pid file as identity), copies serve's own restart counters into the row, and writes every result plus a `self` row of the sampler's own CPU, fs blocks, context switches, RSS and wall time in one transaction. `titan health uptime` reports up, down, unknown and missing slots, both up shares, the gaps and serve's restart and unclean-start deltas (with `--min` as a gate); `titan health cost` reports the sampler's per-tick cost and the store size; `titan health import` loads the old stopgap JSONL idempotently. It makes no model or tool calls. The contract, probe, store and uptime fold live in the `health` package; to serve a health route, use daemon.

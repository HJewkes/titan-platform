# titan: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You want this host's services sampled on a schedule and kept: `titan health sample` probes each target (by default the factory's loopback `/health`, with its pid file as identity), copies serve's own restart counters into the row, and writes every result plus a `self` row of the sampler's own CPU, fs blocks, context switches, RSS and wall time in one transaction. `titan health install` puts it on a minutely systemd user timer. It makes no model or tool calls. The contract, probe, store and uptime fold live in the `health` package; to serve a health route, use daemon.

---
"@titan-design/titan": minor
---

Add the titan host CLI with `titan health sample`. One tick probes every target in parallel (by default the factory's loopback `/health`, with its pid file as identity and serve's restart counters copied into `observed`), adds a `self` row with the sampler's own CPU, fs blocks, context switches, max RSS and wall time, and stores all rows in one `appendSamples` call.

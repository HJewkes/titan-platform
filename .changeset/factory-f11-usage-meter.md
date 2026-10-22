---
"@titan-design/factory": minor
---

Add the F11 meter for per-identity GitHub rate-limit peaks. Serve's bot identity feeds every bot response's `x-ratelimit-*` headers to a usage meter that keeps the max `used` per resource per reset window, and serve logs a `github-api.usage` line every 5 minutes and a `github-api.peak` line hourly (identity `bot`, resource, used, limit, pct, reset), so the F11 report reads the serve log alone and the token never leaves serve. `scripts/f11-rate-sample.mjs` is the HJewkes-side sampler: run as that identity, it appends one JSONL record of `gh api rate_limit` (core and graphql) per minute, and `--peaks` prints the max `used` per reset window.

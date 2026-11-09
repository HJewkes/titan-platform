---
"@titan-design/factory": patch
---

The planner window probes now reject impossible dates such as `2026-02-30T00:00:00Z` in `--since`, in event times and in a round's `submittedAt`, through one round-trip check in `iso-time.ts`. A round whose feedback fails its schema now names the failing fields instead of always blaming `submittedAt`.

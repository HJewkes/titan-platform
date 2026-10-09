# metrics

The metrics registry: one `<area>.yml` per system, a `titan.metrics/v1` entry (schema in
`@titan-design/health/metrics`) keyed by an area id from `scripts/areas.mjs`. A measurement audit
writes each entry; dashboards, the digest and `stats --slo` read them instead of hard-coding metrics.

`pnpm metrics:check` validates every entry and its area. Queries name store ids, never machine
paths or personal data, because this repo is public.

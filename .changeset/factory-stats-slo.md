---
"@titan-design/factory": minor
---

`titan-factory shepherd stats --slo` evaluates the checkout's `metrics/shepherd.yml` (or `--registry <file>`): for each metric it prints the value over the SLO's window (or `--from`/`--to`), the SLO, and `pass`, `fail`, `no-data`, `no-slo`, `no-query` with the metric's gap slice, or `error`; `--json` returns `{ "slo": [...] }`. A registry query names one of the stats SLO queries by id; a window with nothing to measure reports `no-data`, never a zero.

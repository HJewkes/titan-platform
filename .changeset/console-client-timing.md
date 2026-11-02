---
"titan-console": minor
---

The console times each route's first data in the browser and reports it, with per-query timings, to a new `perf.report` deposit command every 10 seconds or when the tab hides. A route row carries its view key and whether it is a detail page, never the id or query. A post holds at most 100 rows, later rows are dropped and counted, and the command accepts only known view keys and registered command names.

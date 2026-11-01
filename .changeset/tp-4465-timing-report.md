---
"@titan-design/test-timing": minor
---

Add the corpus queries. `readSeries` reads one series per suite, project or file over full-scope runs, summing a sharded run's shards into one point and dropping a run missing a shard. `timingReport` gives each suite's newest runs against their rolling minimum (anomalous when `hold` runs in a row are over it), growth where a min-of-last-N rose 25% over its trailing baseline, and every project's trend. `slowerSince` lists what got slower after a cut, which `commitStartedMs` finds from a sha prefix. The pure `trendOf`, `growthOf`, `runVerdicts` and `shiftAt` are exported with their default rules.

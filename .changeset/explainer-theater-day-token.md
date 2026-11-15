---
'@titan-design/explainer': minor
---

Expand a literal `{day}` in a bridge's `theater.dir` to the run's gather day, so each daily exports to its own folder instead of replacing the last one's video. A `{day}` bridge for a run with no gather day is refused, naming `--theater`, and an explicit `--theater` still wins.

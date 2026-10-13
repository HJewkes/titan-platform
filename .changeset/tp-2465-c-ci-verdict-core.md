---
"@titan-design/github": patch
---

`ciVerdict` builds on checks.ts: a required context's newest run is `latestPerName`'s pick (a tied start goes to the higher id, an unstarted rerun reads pending), success is `isSucceeded` and the all-runs rule uses `isPassing`. Its own conclusion set and picker are gone.

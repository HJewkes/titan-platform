---
"@titan-design/github": patch
---

`ciVerdict` builds on checks.ts: any unfinished run of a required context and app reads pending whatever its start time or id, and once every run has completed the newest is `latestPerName`'s pick (a null or tied start goes to the higher id). Success is `isSucceeded` and the all-runs rule uses `isPassing`. Its own conclusion set and picker are gone.

---
"@titan-design/factory": minor
---

`/health` now reports `busy: [{ runId, step, phase }]`: running runs whose current step is in review or merging, or routed `onRestart: "park"` (phase `park`). `service restart` polls it until `busy` is empty or `--drain-timeout` (default `45m`) passes, printing the busy runs each minute, then kickstarts. A park-routed step still busy at the deadline refuses the restart unless `--force`; `--no-drain` skips the wait. `ServicePorts` gains `now`, and `factoryHealth` takes an optional `routeFor`.

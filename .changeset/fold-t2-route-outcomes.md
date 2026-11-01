---
"@titan-design/session-analytics": minor
---

`routeOutcomes` joins routed spawns (the `session_origin.route_*` columns) to their PRs and Shepherd runs. It groups them by table, mode, prior, estimate band, profile, source and agreement, never pooled, and reports spawns, merged PRs, first-pass clean %, review rounds and fix-round spawns per PR, and implementer and all-in $ per merged PR. A run joins on its PR and the spawn's task, so two slices of one task never share a PR.

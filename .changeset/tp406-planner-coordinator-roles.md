---
"@titan-design/session-analytics": minor
---

Map the `planner` and `fable-coordinator` spawn profiles to roles: `planner` was already a
`WorkerRole` value with no profile mapped to it, and `fable-coordinator` needed a new
`coordinator` `WorkerRole` value. Both profiles previously fell through to `worker:unknown`.

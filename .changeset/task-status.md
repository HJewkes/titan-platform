---
"@titan-design/session-read": minor
"@titan-design/session-graph": minor
---

Derive task status from transcript content. `parseTaskIntents` reads every
`active-work`/`aw` task invocation in a compound command, not just one anchored at the
start of the line, and reports the status the `done` and explicit `edit … status` forms
state. Task events carry that status, the folder lets a closing mention upgrade an earlier
read, and the graph writes it with a COALESCE that a later bare mention cannot erase.

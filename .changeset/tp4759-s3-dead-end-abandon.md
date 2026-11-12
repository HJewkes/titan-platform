---
"@titan-design/factory": minor
---

A dead-end gate answered abandon now closes the PR, keeps its branch and reopens its task (TP-4759 S3). The new
`sh-abandon` step acts only while GitHub shows the PR open at the gate head: it runs `agent-chat gh-write -- pr close`
with no `--delete-branch`, reopens the registered task with a note, and stops the run as abandoned. A PR already closed
is not closed again, and a head that moved closes nothing and asks again. Off until `GATE_DEMOTIONS.deadEndSeat` is on.

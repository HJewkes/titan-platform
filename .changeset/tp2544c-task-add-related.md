---
"@titan-design/active-work": minor
---

`task add` lists up to three related open tasks from the same initiative in `warnings` for agent callers. The list is advisory and fails open: a missing or degraded index, a thrown read or a 1 s deadline prints nothing and leaves the task filed. Humans and `/rpc` callers skip the read, which costs about 0.7 s per add (TP-2544).

---
"@titan-design/factory": patch
---

Shepherd's two-MERGE release of a `g10-adversary` hold no longer requires the correctness reviewer and the adversary to run at different profiles. Decision 457 runs both on `bd-reviewer`, and under the old rule no such hold could release. Two MERGEs now count as independent when the broker roster shows the reviewers share no conversation: separate sessions, and no resume, context fork, takeover or common spawning session between them. An unread roster fails closed. Correctness must still run on an Opus profile (TP-3524).

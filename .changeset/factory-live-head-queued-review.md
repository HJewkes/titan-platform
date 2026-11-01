---
"@titan-design/factory": patch
---

A review the spawn gate has deferred now reads its pull request's head on every pass of the queue and, when the head moved, finishes superseded and leaves the queue, so no reviewer is started for a head the PR already left (TP-4487).

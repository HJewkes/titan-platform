---
"@titan-design/factory": patch
---

Shepherd: a changed-files read that threw at merge time (a rate-limit 403, a 5xx) no longer parks an owner approve-merge gate. Land waits at the head with the settle backoff and re-reads the evidence; past the 20-minute bound the seat is told once and the wait goes on. A truncated list still gates the owner at once, and unread files never merge (TP-6758).

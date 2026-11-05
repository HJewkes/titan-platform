---
"@titan-design/factory": patch
---

The seat digest reaches only a seat with a live session, by the same routing as seat notices: a retired seat's digest
goes to the repo's `shepherd.redSeat` entry, the red seat fallback or `shepherd.hubSeat`, whichever is live first. With
none live, no digest is sent and serve logs why; an unreadable roster keeps the seat (TP-4050).

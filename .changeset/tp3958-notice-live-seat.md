---
"@titan-design/factory": patch
---

Seat notices and exit notices reach only a seat with a live session: a retired seat's notice goes to the repo's
`shepherd.redSeat` entry, the red seat fallback or `shepherd.hubSeat`, whichever is live first, and the step's detail
names it. A non-fixer registrant receives a run's notices and digest only while live, else the repo's seat (TP-3958).

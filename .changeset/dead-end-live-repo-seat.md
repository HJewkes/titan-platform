---
"@titan-design/factory": patch
---

A dead-end gate's repo-seat fallback now names a seat only when it holds a live session on the roster. A retired single seat falls back to a live `shepherd.hubSeat`, else the gate stays the owner's, so `readdress-dead-ends` no longer routes gates to a finished seat.

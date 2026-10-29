---
"@titan-design/factory": patch
---

The main watch reads `shepherd.hubSeat` and `shepherd.redSeat` on every call, so an edit to either applies to the next sweep without restarting serve (TP-4484).

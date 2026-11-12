---
"@titan-design/active-work": patch
---

The session-index scheduler asks the gate again when a hold-cap pass ends, so readers get fresh reads as soon as the gate has opened instead of waiting for the next poll (TP-5186).

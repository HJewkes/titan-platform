---
"@titan-design/factory": minor
---

Pace Shepherd seat digests under `shepherd.seatDigest.pacing` (TP-4207): a new gate or seat-fix item sends after a settle window, and finished runs and cleared items batch until a flush time or batch size. With no pacing config, digests go out as before. A PR whose item moves from one gate to another now reads as `Changed:`, not `Cleared:`.

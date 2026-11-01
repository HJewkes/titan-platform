---
"@titan-design/agent-dispatch": minor
---

Add the `/host` ports `AgentJournal`, `PresencePort`, `AdmissionLedger` (types only) and `RetireHoldPort`, plus an in-memory `memoryHost` that implements all four. Its admission ledger always admits and records each call.

---
"@titan-design/session-graph": minor
---

`session_origin` gains a nullable `execution_phase` column (migration 17, "origin execution phase"), and `ResolvedOrigin` carries `executionPhase`. A launcher's resolver sets it to the phase its execution ledger records for the session, so a session's outcome is queryable without reading the transcript.

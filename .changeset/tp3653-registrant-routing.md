---
"@titan-design/factory": minor
---

Shepherd sends seat notices, exit notices and the seat digest to the session that registered the run (TP-3653). `shepherd register` records `AGENT_CHAT_NAME` as the run's registrant, and only the first one is kept across restarts and successor registrations. An implementer that registered its own PR has them sent to the first session that spawned its lineage. A run with no registrant still goes to the repo's seat. Adds factory migration 38 (`registrant`, `registrant_fixer` on `shepherd_registration`).

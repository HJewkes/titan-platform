---
"@titan-design/agent-protocol": patch
"@titan-design/agent": patch
---

Add a pure caller-bound Codex pricing port and optional quote-service injection in the Codex exec adapter. Preserve legacy pricing behavior, quote captured turn usage once across success/failure paths, and keep unpriced usage distinct from priced zero.

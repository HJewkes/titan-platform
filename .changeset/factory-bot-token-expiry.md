---
"@titan-design/factory": minor
---

The bot client reads GitHub's `github-authentication-token-expiration` header on every response. `/health.bot` gains `expiresAt` (ISO time, null before the first response or for a token with no expiry), and with 14 days or less left serve logs one `factory: ops-alarm bot-token-expiry` line per token fingerprint. `ops/runbooks/bot-token-rotation.md` covers the token write for both host options, the restart and reload check, and the classic-token E16 check.

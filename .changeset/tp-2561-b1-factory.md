---
"@titan-design/factory": minor
---

Serve reaches GitHub through `octokitWire` on one shared client per process, and so does the review-check publish (TP-2561 b1). Two new RPCs:
- `shepherd.ghRead` answers whitelisted GET routes through that client's ETag cache, or from the PR snapshot. It refuses any other route or method.
- `shepherd.ghBudget` reports the client's rate windows and cooldowns.

Each real gateway call logs one `shepherd: gh-call` line.

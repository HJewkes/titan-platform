---
"@titan-design/factory": patch
---

Shepherd no longer counts a reviewer that a busy broker never started (machine guard or any `retryable: true` refusal) as a failed review round, so it retries at the same head instead of opening approve-merge.

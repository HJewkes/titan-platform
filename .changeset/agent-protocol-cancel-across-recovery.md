---
"@titan-design/agent-protocol": patch
---

Keep a requested cancellation across a recovery: `observe_running` after `recovery_required` now returns phase `cancel_requested` instead of `running` when a cancellation was recorded.

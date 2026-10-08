---
"@titan-design/factory": patch
---

Add owner-queue `QueueSource` adapters for agent-chat's `/api/queue` and the factory's pending hitl gates. A failed or refused read throws a typed `QueueReadError`, and a new `queue-counts` verb prints each source's open items split by kind.

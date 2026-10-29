---
"@titan-design/factory": patch
---

The autoresearch planner's round-1 brief now carries the run and target, the adapter's `program.md` (inline, or its path when the clone lacks it), the `target.json` and `bounds.json` paths, the quotas, and the queue-ops JSON Schema derived from `QueueOpsSchema`. Resumed rounds restate the end contract in one line.

Both briefs state this round's quotas with their numbers (minimum pool, the net adds it takes, the kept ideas owing a follow-up), worded by `quotaRules` from the run's settings.

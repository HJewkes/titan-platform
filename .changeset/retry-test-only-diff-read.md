---
"@titan-design/factory": patch
---

Shepherd's fix-proof step reads a test-only PR's diff a second time when the first read fails, so one transient GitHub error no longer ends a test-only review as NO_REPRO and wakes the implementer for nothing. When the diff is still unread after the retry, the sh-fix-proof step output records the reason as `unreadDiff` next to the result. A correctness run's verdict is unchanged.

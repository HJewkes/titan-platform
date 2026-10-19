---
"titan-console": patch
---

The inbox action tests import `CONFIRM_TTL_MS` from `owner-tap.ts`, so `inbox-actions.ts` no longer re-exports it.

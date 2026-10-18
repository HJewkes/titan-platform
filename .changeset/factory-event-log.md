---
"@titan-design/factory": patch
---

The factory database gains migration 30, `factory:event_log`: an append-only `factory_event` table, with UPDATE and DELETE aborted by triggers. Internal `appendEvent`, `headSeq` and `readEvents` write and read it. Nothing reads it yet.

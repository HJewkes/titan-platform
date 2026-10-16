---
"titan-console": minor
---

`titan-console rounds withdraw <id> --reason <new-head[:<sha>]|closed|answered-elsewhere> [--json]` marks an unanswered round superseded by writing `withdrawn.json` beside it, once; an answered round is kept. `rounds.list` and `rounds.get` report a `withdrawn` status, `rounds.submit` refuses a withdrawn round before writing anything, and `approvals.flow` lists its questions under `withdrawn` instead of the open queue. The verb is CLI only, never an `/rpc` command.

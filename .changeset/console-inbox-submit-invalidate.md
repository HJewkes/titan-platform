---
"titan-console": patch
---

Drop the inbox's kept factory and Shepherd reads when a round is answered through `rounds.submit` or `rounds.answer-rec`, both once the feedback is written and again once the gate listener settles, so an answered round and its gate leave `inbox.list` on the next call. `approvals.flow` now shares the inbox's kept factory read.

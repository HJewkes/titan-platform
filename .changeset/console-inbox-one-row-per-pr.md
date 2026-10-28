---
"titan-console": minor
---

Trim the inbox's Blocking section further (TP-4352). A PR keeps one blocking row, its newest ask. An sh-sent-back gate blocks only beside a deposit op on its PR. Personal deposits and agent-chat approvals over a day old move to Planning. A blocking item open past four days carries `aged: true` and is listed under "Older than 4 days" inside Blocking, never hidden.

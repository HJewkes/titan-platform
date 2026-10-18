---
"titan-console": patch
---

Let `inbox.act` answer an agent's chat_ask. `inbox.prepare` reads back the question, its asker, options and recommendation; `inbox.act` takes the owner's `text`, keeps it in the action record, and posts it to the agent-chat broker's `POST /api/answer` on channel `dashboard` through a new `BrokerAnswerer`. Redirects are never followed, a question answered first elsewhere comes back `closed`, and a broker that is down is `unreachable`.

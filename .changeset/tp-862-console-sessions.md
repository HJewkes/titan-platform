---
"titan-console": patch
---

Add the Sessions pages. `#/sessions` lists `sessions.list` in a table (agent, tasks, PR, started, duration, tokens, cost) with an `?agent=` filter, "Load more" on the `before` cursor and an "Indexed to" caption. `#/sessions/<id>` renders `sessions.timeline` as a header of facts, a Conversation tab of collapsible turns and a Files tab whose touched files link to their codewatch node when the server mapped one. Loading, empty, not-found and degraded states are keyed on the degraded reason.

---
"titan-console": patch
---

Add the `agents.messages` and `agents.queue` read commands. `agents.messages` lists an agent's messages, or a pair's, newest first. It pages them with an id cursor from agent-chat's events.db, opened read-only (`TITAN_CONSOLE_EVENTS_DB`, by default `events.db` under `AGENT_CHAT_HOME`). When that file is absent it falls back to the broker's `/api/history` window and marks the result `partial`. `agents.queue` reads `/api/queue` and lists questions first, with each item's asker and age. The broker's own exit and lifecycle notices are counted, not listed, unless `include_system` is set. Neither command writes to the broker or to events.db. A missing ui token, or an events table without the columns read, exits 69.

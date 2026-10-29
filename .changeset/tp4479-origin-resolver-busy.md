---
"@titan-design/active-work": patch
---

Open agent-chat's events.db with a 100 ms busy timeout when resolving session origins, so a session-index refresh no longer blocks up to 5 s while agent-chat holds the database.

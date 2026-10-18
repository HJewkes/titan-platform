---
"titan-console": patch
---

Add `inbox.prepare` and `inbox.act`, behind `TITAN_CONSOLE_INBOX_ACTIONS=1`. `inbox.prepare` reads back a gate resolve or an owner-asked hold release with a five-minute confirm digest. `inbox.act` is an owner-write: it re-reads the item, refuses a stale digest before posting, writes the action record once and posts its id to the factory's `POST /owner/console-action`. A moved head comes back as `moved` and a replay as `already`.

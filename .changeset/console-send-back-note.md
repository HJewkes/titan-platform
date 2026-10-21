---
"titan-console": patch
---

Ship rounds follow owner decision 513: Send back only needs a note. Unanswered required side questions no longer hold it, and go with it as unanswered. Send back stays off, with the reason beside it, until there is a comment on the Ship question or a round note, the only text the fixer receives (the factory refuses an empty note). `rounds.submit` refuses a Send back with neither, with the same reason, and writes nothing.

---
"titan-console": patch
---

Add the owner-queue readers for the console's own sources: `readQueueRounds` reads each valid round with its validated `feedback.json`, and `roundQueueItems`/`spoolQueueItems` turn rounds and spool deposits into open or answered owner items, with every unreadable file a gap line.

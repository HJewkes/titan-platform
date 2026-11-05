---
"titan-console": patch
---

Decode and diff a changed frame on a worker thread, so a first view of a large frame delta no longer holds the daemon event loop (TP-4687).

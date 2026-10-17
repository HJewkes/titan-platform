---
"titan-console": patch
---

Round re-import now checks every destination frame's sha256 and every parent directory before it writes anything, and refuses a tampered frame instead of reporting it imported.

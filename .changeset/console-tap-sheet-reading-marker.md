---
"titan-console": patch
---

Mark a confirm sheet's reading spinner with a test id, so tests open every sheet through one helper that waits for the prepare's read-back instead of racing it (TP-4634).

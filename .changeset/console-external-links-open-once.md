---
'titan-console': patch
---

Open console links to outside pages in one tab: the anchor Links no longer also call `window.open`, which opened each URL twice (TP-6235).

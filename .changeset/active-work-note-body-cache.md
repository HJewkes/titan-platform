---
'@titan-design/active-work': patch
---

Workspace refresh now caches note bodies by path, mtime and size, so it re-reads only notes that changed or are new instead of every note on each pass (TP-6339).

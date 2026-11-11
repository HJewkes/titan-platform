---
'@titan-design/active-work': patch
---

Inject the logger, daemon start and watcher options into `runDaemon` so its tests no longer mock internal modules (TP-5218 slice S6).

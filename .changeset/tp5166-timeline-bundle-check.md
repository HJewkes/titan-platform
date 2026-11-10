---
"@titan-design/session-analytics": patch
---

Test support only: the `./timeline` browser-safe test now bundles the entry for the browser platform and fails if the import graph reaches a Node built-in, SQLite, session-graph or session-read module. No production code changes.

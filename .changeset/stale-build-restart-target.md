---
"@titan-design/factory": patch
---

`titan-factory service check` reports a stale build only when the deploy checkout a restart loads is at a commit newer than the running build, so it no longer advises a restart that would roll serve back.

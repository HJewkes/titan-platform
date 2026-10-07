---
"@titan-design/retrieval": patch
---

Honour a signal that is already aborted when the search starts: every retriever now degrades with reason `error` instead of running to completion.

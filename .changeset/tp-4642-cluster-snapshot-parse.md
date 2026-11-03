---
"@titan-design/cluster": minor
"@titan-design/session-miner": patch
---

Add `parseClustererSnapshot`, which narrows a stored snapshot from `unknown`, refuses a wrong shape or version and keeps unknown keys. `zod` is now a peer dependency of cluster. session-miner's `drain.ingest` reads its stored snapshot through it, so a malformed row stops the run with a clear error.

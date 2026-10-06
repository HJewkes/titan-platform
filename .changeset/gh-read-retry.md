---
"@titan-design/github": patch
---

Retry a gh read that fails with HTTP 5xx, a connection error or an unparseable body, up to three attempts with a short backoff. Writes are never repeated; update-branch re-reads the PR when its answer cannot be parsed.

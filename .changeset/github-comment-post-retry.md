---
"@titan-design/github": patch
---

Retry a comment post that fails with a 5xx or an unreadable answer: each retry first reads the PR's comments back and counts an existing marker comment as done, so the Shepherd merge-evidence comment is never posted twice. `GitHubPortOptions.sleep` injects the backoff wait.

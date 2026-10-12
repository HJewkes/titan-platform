---
"@titan-design/factory": patch
---

Shepherd's PR snapshot keeps the open list's ETag across `invalidate`. An invalidate now marks the list stale and drops the PR details, but keeps the ETag and the check runs keyed by head sha, so the read after a write is a conditional GET: a 304 keeps the rows and a 200 replaces them. A list read that an invalidate overtakes is dropped and read again.

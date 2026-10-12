---
"@titan-design/factory": patch
---

Shepherd's PR snapshot keeps the open list's ETag across `invalidate`. An invalidate now marks the list and the check runs stale and drops the PR details, but keeps the ETag, so the read after a write is a conditional GET: a 304 keeps the rows and a 200 replaces them. Check runs are read again after an invalidate, so a re-run of failed jobs is seen at once. A list read that an invalidate overtakes is dropped and read again.

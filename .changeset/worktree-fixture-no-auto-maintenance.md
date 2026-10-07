---
"@titan-design/worktree": patch
---

The repo-test git fixture turns off git's auto gc and maintenance in its template repository, so a detached maintenance run cannot change `.git/objects` while the template is being copied.

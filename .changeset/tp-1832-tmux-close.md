---
"@titan-design/agent-surface": patch
---

`close()` on a tmux window that already exited now reports `closed: true` instead of failing, and a `tmuxSession` containing `:` or `.` is refused, since tmux would rename it.

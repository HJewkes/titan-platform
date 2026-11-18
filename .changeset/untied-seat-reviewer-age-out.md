---
"@titan-design/factory": patch
---

An unreadable seat reviewer that no registration ties to any PR no longer holds every registered PR forever (TP-2886). Once every roster row of its name is exited or deregistered and its newest write is at least 4 hours old, the seat check clears with a warning naming it. Until then it still blocks with a retry, and the reason names the reviewer, `agent-chat agent retire <name>` and the age-out time, or why it never ages out (a row still running, or no write time). Transient read failures and reviewers tied to this PR are unchanged.

---
"@titan-design/factory": patch
---

A fixer woken for FIX_FIRST or ci-failed that exits with no new head now gets its repo's seat one agent-chat message per run and head, instead of the owner's `sh-sent-back` gate. The message names the PR, head, round, wake mode and the agent's last report. The new `sh-exit-notice` step records whether the agent exited before reading a live wake (`unread`) or read it and pushed nothing (`read-no-push`). The gate still opens if the send fails, no single seat owns the repo, or the agent exits again at the same head.

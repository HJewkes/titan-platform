---
"@titan-design/factory": patch
---

Shepherd parks the worktree of each exited `rv-<owner>-<repo>-<pr>` reviewer at every green head, so finished review rounds no longer leave trees behind. A refusal is logged, sent to the seat, and retried at the next round end.

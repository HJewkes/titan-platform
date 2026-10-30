---
"@titan-design/factory": minor
---

Add `titan-factory blocker raise|clear|list`. Any seat raises a hard blocker as an owner-inbox deposit carrying `blocker { since, blocks }`, within the per-asker cap of five open deposits; a repeat raise of an open slug keeps its first `since`. `clear` withdraws it through the spool's withdraw audit log, recording the actor beside the asker, and `list` prints open blockers oldest first, or as JSON with `--json`.

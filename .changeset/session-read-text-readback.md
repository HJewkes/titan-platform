---
"@titan-design/session-read": minor
---

Add `projection: "text"` to `readRecentSessionTurns`. It keeps only user and assistant text and applies `maxTurns` after tool activity, thinking and system rows are dropped, so a readback gets the last N spoken turns.
Add `claudeSourceFromPath(path, namespace)` for consumers that already hold a transcript path. The observed model now skips Claude Code's `<synthetic>` placeholder on locally generated error rows.

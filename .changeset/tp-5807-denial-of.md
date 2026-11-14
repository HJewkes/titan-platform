---
"@titan-design/session-analytics": minor
"@titan-design/session-miner": patch
---

Add `denialOf`, the one classifier for Claude Code permission, auto-mode-classifier and permission-hook-deadline text (TP-5807). The friction gate, blocked-flow denials, the tool-errors insight and the reviewer smoke check now use it, so a non-error result worded "was denied" is counted as a denial.

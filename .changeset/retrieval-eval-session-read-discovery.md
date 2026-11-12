---
"@titan-design/retrieval-eval": minor
---

Discover transcripts through `@titan-design/session-read`, so `mine`, `uptake` and `served` now read subagent sidechains and honour `CLAUDE_CONFIG_DIRS`. The `defaultTranscriptRoots` and `discoverTranscripts` exports are removed; use session-read's `claudeTranscriptRoots` and `discoverAllTranscripts`.

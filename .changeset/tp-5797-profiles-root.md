---
"@titan-design/anthropic-account": minor
"@titan-design/active-work": patch
"@titan-design/factory": patch
"@titan-design/session-miner": patch
"@titan-design/titan": patch
---

Export `profilesRoot(env, home)` from `@titan-design/anthropic-account/node` as the single resolver of the Claude profiles root, and use it in active-work, factory context-audit, session-miner friction transcripts and the titan config report. `CLAUDE_PROFILE_ROOT` now applies to all of them; a relative value is ignored.

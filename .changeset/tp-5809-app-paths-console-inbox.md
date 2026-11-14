---
"@titan-design/app-paths": minor
"@titan-design/factory": patch
"@titan-design/explainer": patch
"@titan-design/yt-scout": patch
"@titan-design/session-miner": patch
---

Export `consoleInboxDir` and `scorecardStorePath` from app-paths and use them in place of the per-product copies (TP-5809). The console inbox spool now expands a leading `~` in `TITAN_CONSOLE_STATE` in yt-scout, and the factory's eligibility check expands a `~` in `TITAN_SCORECARD_STORE`; the other resolutions are unchanged.

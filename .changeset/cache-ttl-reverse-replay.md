---
"@titan-design/session-analytics": minor
---

`cacheTtlWhatIf` replays sessions already on 5m toward 1h: a 5-60 minute gap rebuild reverts to a read of `min(write, previous prompt)`. The saving is reported per role and profile as `reverseReverts`, `reverseTokens` and `reverseSavingUsd`.

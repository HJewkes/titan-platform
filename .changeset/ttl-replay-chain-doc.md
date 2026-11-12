---
"@titan-design/session-analytics": patch
---

The `reverseReplayTokens` doc comment now says the 5m-only test applies per chain rather than per session, and a test shows a main chain on 5m is replayed when only its sidechain wrote at 1h. Doc and test only; no behavior change.

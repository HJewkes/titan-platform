---
"@titan-design/session-analytics": patch
---

The cache-ttl gap cause and the transcript friction cluster now share one ci-wait head rule (`ci-wait`, `gh pr checks`, `gh run`) from `ci-wait-head`. Friction now reads every `gh run` subcommand as a CI wait, where it read only watch, view and list.

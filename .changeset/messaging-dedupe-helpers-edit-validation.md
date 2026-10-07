---
"@titan-design/messaging": patch
---

Telegram `edit` now checks text length and button data size before calling the API, returning `too-long` or `bad-buttons` with no request sent, as `send` does. `redactPassword`, `redactToken`, `describeCause` and the abort check share one implementation each; both redactors stay exported. The `callBotApi` doc comment now names the `getUpdates` and `getMe` paths that bypass it.

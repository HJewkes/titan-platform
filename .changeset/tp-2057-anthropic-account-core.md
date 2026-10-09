---
"@titan-design/anthropic-account": minor
---

Add `@titan-design/anthropic-account` with a pure core: `UsageReading`, `parseUsageReading` and `usageFromOAuthResponse` for rate-limit readings in the status-line shape; the token-free `LoginState` with `loginStateFromCredentials` and `needsRefresh`; `accountLabel`; and `redactSecrets` for strings and Errors. The root entry has no fs, process or network access.

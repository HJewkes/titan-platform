---
"@titan-design/github": minor
"@titan-design/factory": patch
---

A GitHub answer that `classifyGitHubFailure` calls a rate limit now fails with a `[gh-rate-limit …]` marker first in its `GhError` message, on both the `gh` CLI and the Octokit transports; `rateLimitMarker` writes it and `parseRateLimitMarker` reads it back. Shepherd uses it: a repeat-safe step whose failed call was a read that met a primary limit, a secondary limit or a 429 now waits until `retry-after`, or `x-ratelimit-reset` plus 5 s (60 s when neither is given, at most 61 min a wait), and reads again, up to two waits, instead of failing the run. A third limit, or a limit on a write, still fails, now filed under the new `gh-rate-limit` failure class.

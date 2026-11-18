---
"@titan-design/anthropic-account": patch
---

Report a credentials file left by a timed-out sign-in (empty tokens, zero expiry, a `loginEnded` reason) as `logged out (time_limit)` instead of `login refused (malformed)`. `LoginState` gains a `logged-out` variant carrying the reason; truly bad files still read as malformed.

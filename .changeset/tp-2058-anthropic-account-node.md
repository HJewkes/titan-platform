---
"@titan-design/anthropic-account": minor
---

Add the `./node` subpath: `discoverProfiles` lists `~/.claude` and `~/.claude-profiles/*` (or `CLAUDE_CONFIG_DIRS`) as labelled profiles; `readLoginState` reads `.credentials.json` only after an `lstat`, an `O_NOFOLLOW` open and an `fstat` on that descriptor show a regular file of mode 0600 or narrower owned by the caller, and refuses a second hard link, and returns a token-free `LoginState`; `readUsage` returns the newest reading in `status-cache/sessions`, read through the same descriptor gate with a bounded read and its strings redacted; `writeReading` writes `usage-poll.json` atomically with mode 0600. `RefusedReason` gains `not-a-regular-file` and `hard-linked`. The root entry stays pure.

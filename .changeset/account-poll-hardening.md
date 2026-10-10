---
"@titan-design/anthropic-account": patch
---

Harden the poll timer and tidy the CLI.

- The service sets `ProtectSystem=strict` with only the config dirs writable. This is best effort: it takes effect only where the user manager can use unprivileged user namespaces, and a warning is logged on each run where it does not.
- A failed run starts the new `anthropic-account-poll-failed@.service`, which logs an error line and leaves a marker file.
- The timer gains `RandomizedDelaySec`.
- `pollAll` backs a profile off after a 429 (5 minutes, doubling to an hour). The backoff file is read through the same owner-only gate as the credentials file.
- `poll` skips a profile dir with no login instead of exiting 2.
- `status --statusline` falls back past a newer reading that lacks `seven_day`, through a new `windows` option on `readUsage`.
- `discoverProfiles` honours `CLAUDE_PROFILE_ROOT`.

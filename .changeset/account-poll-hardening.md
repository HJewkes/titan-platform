---
"@titan-design/anthropic-account": patch
---

Harden the poll timer and tidy the CLI. The service runs with `ProtectSystem=strict`, writing only the config dirs, and a failed run starts the new `anthropic-account-poll-failed@.service`, which logs an error line and leaves a marker file; the timer gains `RandomizedDelaySec`. `pollAll` backs a profile off after a 429 (5 minutes, doubling to an hour). `poll` skips a profile dir with no login instead of exiting 2. `status --statusline` falls back past a newer reading that lacks `seven_day`, through a new `windows` option on `readUsage`. `discoverProfiles` honours `CLAUDE_PROFILE_ROOT`.

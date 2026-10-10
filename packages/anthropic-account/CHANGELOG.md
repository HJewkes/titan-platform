# @titan-design/anthropic-account

## 0.3.0

### Minor Changes

- 0fb5cf6: Add the `anthropic-account` bin: `poll [--write [--refresh]]` and `status [--json | --statusline]`. A login that is not present exits 2 with one fixed stderr line per account. `poll --write --refresh` renews due access tokens with `refreshIfNeeded` before polling, so it writes `.credentials.json`. The package now ships systemd user templates in `systemd/` that run it every 150 s; nothing is installed or enabled.

### Patch Changes

- 37550f4: Harden the poll timer and tidy the CLI.

  - The service sets `ProtectSystem=strict` with only the config dirs writable. This is best effort: it takes effect only where the user manager can use unprivileged user namespaces, and a warning is logged on each run where it does not.
  - A failed run starts the new `anthropic-account-poll-failed@.service`, which logs an error line and leaves a marker file.
  - The timer gains `RandomizedDelaySec`.
  - `pollAll` backs a profile off after a 429 (5 minutes, doubling to an hour). The backoff file is read through the same owner-only gate as the credentials file.
  - `poll` skips a profile dir with no login instead of exiting 2.
  - `status --statusline` falls back past a newer reading that lacks `seven_day`, through a new `windows` option on `readUsage`.
  - `discoverProfiles` honours `CLAUDE_PROFILE_ROOT`.

- 6eea59d: A refresh that reclaims an abandoned lock no longer removes the holder record afterwards, so an acquirer that takes the freed lock in between keeps its fresh record.
- 167611d: `refreshIfNeeded`'s lock holder record is now created with `O_EXCL | O_NOFOLLOW`, so a symlink at its path is never written through. It is read through the credentials gate (owner, mode, link count, no blocking on a FIFO). A release that throws still frees the lock dirs and no longer turns a `write-failed` result into `io`.

## 0.2.0

### Minor Changes

- 2fc4fd9: Add `refreshIfNeeded` to the `./node` subpath. When `needsRefresh` says a profile's access token is due, it takes Claude Code's own two refresh locks, re-reads `.credentials.json` through the 0600 gate, and sends Claude Code's refresh request: `POST https://platform.claude.com/v1/oauth/token` with `grant_type`, `refresh_token`, `client_id` and `scope`. It then writes the new credentials to a temp file in the same dir (exclusive, 0600, fsync), checks once more that no other writer changed the file, renames the temp file over it and fsyncs the dir. It never truncates in place and never steals a lock Claude Code holds; a lock it left behind itself, whose recorded holder process has exited, is reclaimed. If the file changes while the request is in flight, it compares the login rather than the bytes. While the file still holds the refresh token just spent, it merges the new tokens onto the other writer's file, so a rotated refresh token is never dropped. It yields with `refreshed-elsewhere` only to a different login or a logout, and reports `write-conflict` if it still cannot store the new tokens. Only the token fields and their expiries change; every other byte is kept. A rotated refresh token is stored. Every failure is a message-free value, and each one goes to an `onFailure` callback as an owner-queue deposit. The deposit names the profile label and the failure kind, and its `depositId` is stable per profile per UTC day, with a separate id for failures that need a new login. If storing a rotated refresh token throws, the failure is `write-failed`, which asks for a new login.

### Patch Changes

- d4895bf: Harden `pollUsage`: a known usage window in an unexpected shape now makes the whole reading `malformed` instead of being dropped, and `fetch` is optional, defaulting to `globalThis.fetch`. The docs say the supplied `fetch` receives the raw access token in the `authorization` header.

## 0.1.0

### Minor Changes

- a109b70: Add `@titan-design/anthropic-account` with a pure core: `UsageReading`, `parseUsageReading` and `usageFromOAuthResponse` for rate-limit readings in the status-line shape; the token-free `LoginState` with `loginStateFromCredentials` and `needsRefresh`; `accountLabel`; and `redactSecrets` for strings and Errors. The root entry has no fs, process or network access.
- 906b22b: Add the `./node` subpath: `discoverProfiles` lists `~/.claude` and `~/.claude-profiles/*` (or `CLAUDE_CONFIG_DIRS`) as labelled profiles; `readLoginState` reads `.credentials.json` only after an `lstat`, an `O_NOFOLLOW` open and an `fstat` on that descriptor show a regular file of mode 0600 or narrower owned by the caller, and refuses a second hard link, and returns a token-free `LoginState`; `readUsage` returns the newest reading in `status-cache/sessions`, read through the same descriptor gate with a bounded read and its strings redacted; `writeReading` writes `usage-poll.json` atomically with mode 0600. `RefusedReason` gains `not-a-regular-file` and `hard-linked`. The root entry stays pure.
- c85944c: Add `pollUsage` and `pollAll` to the `./node` subpath. `pollUsage` reads a profile's access token through the 0600 credentials gate and sends one `GET https://api.anthropic.com/api/oauth/usage` through an injected `fetch`, with the token only in the Authorization header, `redirect: "error"`, a timeout and no retry. It never refreshes: a token within 60 s of expiry is reported `expired`. The body is capped at 64 KiB and parsed against a zod allowlist of window keys. Every failure is a message-free value: `missing`, `refused`, `expired`, `io`, `http-<status>`, `network` or `malformed`. `pollAll` polls every discovered profile and writes each reading with `writeReading`.

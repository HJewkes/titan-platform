# @titan-design/anthropic-account

Tier 0 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Exports the pure core of Anthropic account management: `UsageReading` with
`parseUsageReading` and `usageFromOAuthResponse`, the token-free `LoginState` with
`loginStateFromCredentials` and `needsRefresh`, `accountLabel`, and `redactSecrets`.
The root entry is pure code: no fs, process or network, and a test fails if it imports any.

The `./node` subpath holds the file and network work: `discoverProfiles`, the 0600-gated
`readLoginState`, `readUsage`, the atomic `writeReading`, and `pollUsage` and `pollAll`,
which call the OAuth usage endpoint through an injected `fetch` and never refresh. Only
`refreshIfNeeded` refreshes. It renews a token that is due under Claude Code's own refresh
lock, replaces the credentials file atomically, and yields to any other writer. It reports
each failure once a day per profile through an injected owner-queue deposit callback. See
`site/reference/anthropic-account.md`.

## The `anthropic-account` bin

```sh
anthropic-account poll [--write [--refresh]]
anthropic-account status [--json | --statusline]
```

- `poll` sends one usage request per profile and prints its windows. `--write` stores each
  reading as `<config dir>/status-cache/sessions/usage-poll.json`. A profile dir with no
  login is skipped. With `--write`, a 429 makes that profile wait 5 minutes before its next
  request, doubling on each further 429 up to an hour; skipped runs exit 0.
- `--refresh` first renews every access token due within 10 minutes. **It writes
  `<config dir>/.credentials.json`** and rotates the refresh token, under Claude Code's own
  refresh lock. Leave it off to keep the poller read-only on credentials. A failed refresh
  is printed to stderr; it does not file an owner-queue deposit.
- `status` reads local files only: each profile's login state and newest reading.
  `--json` prints them as one document, and `--statusline` prints the format
  `~/.claude/scripts/rate-limits.sh` prints, from the newest reading that has both the
  five-hour and the weekly window.

Profiles are `~/.claude` and each dir under `~/.claude-profiles`, or under
`CLAUDE_PROFILE_ROOT` when it is set; a non-empty `CLAUDE_CONFIG_DIRS` replaces the scan.

Exit codes: 0 ok, 1 a poll, refresh or read failed, 2 a login is expired or refused (or,
for `status`, missing), 64 a usage error. Each account whose login is not present gets one stderr line,
`anthropic-account: <label>: login <state>`. Output never holds a token or file contents.
`--statusline` always exits 0 and writes no stderr, so the status line shows `unknown`.

## Installing the poll timer

The bin installs and enables nothing. The templates in `systemd/` run
`poll --write --refresh` every 150 s. On the host, its operator runs:

```sh
npm install -g --prefix ~/.local @titan-design/anthropic-account
mkdir -p ~/.config/systemd/user
cp "$(npm root -g --prefix ~/.local)/@titan-design/anthropic-account/systemd/"anthropic-account-poll* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now anthropic-account-poll.timer
journalctl --user -u anthropic-account-poll.service -n 20
```

Remove `--refresh` from the service's `ExecStart` before enabling to keep the timer from
writing credentials files.

The service sets `ProtectSystem=strict` with only `~/.claude` and `~/.claude-profiles` in
`ReadWritePaths`. Treat that as best effort. A systemd user manager can apply it only where
unprivileged user namespaces are allowed. On a host that restricts them, such as Ubuntu with
`kernel.apparmor_restrict_unprivileged_userns=1`, it does nothing and the run can write the
whole home dir. Each such run logs a warning (`ProtectSystem is not in effect on this
host`). The protection that holds everywhere is the CLI's own: it reads credentials only
from this uid's own 0600, singly linked regular file, opened with `O_NOFOLLOW`; it writes
them atomically at 0600; and it refreshes only under Claude Code's refresh lock. Add any
`CLAUDE_PROFILE_ROOT` or `CLAUDE_CONFIG_DIRS` dirs you set for the unit to `ReadWritePaths`. A failed run starts `anthropic-account-poll-failed@.service`, which logs
an error-priority journal line and leaves
`~/.local/state/anthropic-account/anthropic-account-poll.service.failed`; the next
successful run removes it.

The first npm publish is pending and owner-only; trusted publishing is set up after it.

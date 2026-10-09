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

The first npm publish is pending and owner-only; trusted publishing is set up after it.

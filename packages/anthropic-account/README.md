# @titan-design/anthropic-account

Tier 0 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Exports the pure core of Anthropic account management: `UsageReading` with
`parseUsageReading` and `usageFromOAuthResponse`, the token-free `LoginState` with
`loginStateFromCredentials` and `needsRefresh`, `accountLabel`, and `redactSecrets`.
The root entry is pure code: no fs, process or network, and a test fails if it imports any.

The `./node` subpath holds the file work: `discoverProfiles`, the 0600-gated
`readLoginState`, `readUsage` and the atomic `writeReading`. See
`site/reference/anthropic-account.md`.

The first npm publish is pending and owner-only; trusted publishing is set up after it.

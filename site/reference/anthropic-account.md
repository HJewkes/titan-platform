# anthropic-account

**Tier 0.** No titan dependencies. `zod` is a peer dependency.

```sh
npm install @titan-design/anthropic-account zod
```

Status: 0.2. The root entry is pure code with no fs, process or network access, and a test
fails if it gains any. File access lives on the `./node` subpath; network access arrives
there later.

## The problem it solves

The status line, agent-chat's spawn gate, the pace pass and session-read each read
Claude Code account state their own way: which config dirs are accounts, whether a login
is live, and how much of each rate-limit window is used. Each copy also sits close to an
OAuth token. This package holds the shapes once, and keeps the token out of every one:

- `UsageReading`, the status-line document, with `parseUsageReading`.
- `usageFromOAuthResponse`, which maps the OAuth usage endpoint's response into a
  `UsageReading`.
- `LoginState`, which says whether a login is present, expired, missing or refused, and
  when it expires. It has no token field.
- `loginStateFromCredentials` and `needsRefresh`.
- `accountLabel`, which names an account from its config dir.
- `redactSecrets`, which scrubs token-shaped text from a string or an Error.

## When to reach for it

Use it to type or validate a usage reading, to turn a response body from
`GET https://api.anthropic.com/api/oauth/usage` into one, to report a login's state from a
`.credentials.json` object you have already read and parsed, or to scrub a message before
it is logged. For the usage and cost of one agent run use
[`agent-protocol`](/reference/agent-protocol).

## Example

```ts
import {
  accountLabel,
  loginStateFromCredentials,
  needsRefresh,
  redactSecrets,
  usageFromOAuthResponse,
} from "@titan-design/anthropic-account";

const login = loginStateFromCredentials(parsedCredentials, Date.now());
if (login.status === "present" && !needsRefresh(login, Date.now(), 5 * 60_000)) {
  const reading = usageFromOAuthResponse(responseBody, {
    writtenAt: Math.floor(Date.now() / 1000),
    account: accountLabel(configDir),
  });
}

logger.warn(redactSecrets(error).message);
```

## Usage readings

A `UsageReading` is the document Claude Code's status line writes per session. Times are
epoch seconds and percentages run from 0 to 100.

```json
{
  "session_id": "usage-poll",
  "written_at": 1791460800,
  "rate_limits": {
    "five_hour": { "used_percentage": 23, "resets_at": 1791478800 },
    "seven_day": { "used_percentage": 41.5, "resets_at": 1791795600 }
  },
  "source": "oauth-usage",
  "account": "agents"
}
```

`rate_limits` is an open map, so a new window name parses without a release.
`parseUsageReading(input)` returns the reading or `null`, and drops keys it does not know.

`usageFromOAuthResponse(body, { writtenAt, account? })` takes the parsed response body. Each
top-level key whose value is `{ utilization: number, resets_at: string | null }` becomes a
window: `utilization` becomes `used_percentage`, and the ISO `resets_at` becomes epoch
seconds. A null window, a non-window key such as `extra_usage`, and any key that is not
short snake case are dropped. A reset time that does not parse as a date is omitted. The
reading's `session_id` is `usage-poll` and its `source` is `oauth-usage`, so a reader that
takes the newest `written_at` picks it up beside the status line's own readings. It returns
`null` when no window survives, as for an error body.

## Login state

```ts
type LoginState =
  | { status: "present"; expiresAt: number; canRefresh: boolean; subscriptionType?: string; rateLimitTier?: string }
  | { status: "expired"; expiresAt: number; canRefresh: boolean }
  | { status: "missing" }
  | { status: "refused"; reason: "malformed" | "mode-too-wide" | "foreign-owner" | "not-a-regular-file" | "hard-linked" };
```

`loginStateFromCredentials(credentials, now)` takes the parsed `.credentials.json` object and
the current time in epoch milliseconds. `expiresAt` is the access token's expiry in epoch
milliseconds. `canRefresh` is true when a refresh token is present and not past its own
expiry. It returns:

| status | when |
|---|---|
| `present` | `claudeAiOauth` has an access token that expires after `now` |
| `expired` | the access token expires at or before `now` |
| `missing` | the input, or its `claudeAiOauth` block, is absent or null |
| `refused` | `malformed`: the block has no access token, or an expiry outside epoch milliseconds from 1e12 to 1e14, so a seconds or microseconds value is refused |

`mode-too-wide`, `foreign-owner`, `not-a-regular-file` and `hard-linked` come only from the `./node`
reader, which refuses a credentials file before reading it.

`needsRefresh(state, now, marginMs)` is true when the access token expires within `marginMs`
of `now`, and always true for an `expired` state, whatever `now` is passed. It is false for `missing` and `refused`, which need a login, not a
refresh. It throws a `RangeError` for a negative or non-finite margin or a non-finite `now`.

## Credential safety

- No `LoginState` has a field that can hold a token. Token fields are checked for presence
  and type, and their values are never copied.
- `subscriptionType` and `rateLimitTier` are copied only when they look like a short label
  that `redactSecrets` leaves unchanged.
- No input makes `loginStateFromCredentials` throw. An exception from the input, such as a
  getter whose message carries a token, becomes `refused` with reason `malformed`. Only a
  non-finite `now`, a caller bug, throws a `RangeError` with a fixed message.
- The tests use synthetic tokens that carry a canary, and assert the canary is absent from
  every returned value, its `JSON.stringify`, every error message and stack, and every
  redacted Error.

`redactSecrets(text)` returns the string with each match below replaced by `[REDACTED]`.
`redactSecrets(error)` returns a new Error with the redacted message, name and stack, and no
`cause`. The original is left untouched. Redaction never throws: if the original's message
cannot be read, or is not a string, the result is `new Error("[REDACTED]")`.

`usageFromOAuthResponse` never throws either; a body whose getter throws gives `null`.

| pattern | catches |
|---|---|
| `sk-ant-…` | OAuth access and refresh tokens and API keys |
| `eyJ….…(.…)` | JWTs |
| `Bearer …`, `Basic …` | an Authorization header value, quoted or not, of any length |
| `access_token`, `refresh_token`, `id_token`, `token`, `client_secret`, `password`, `authorization`, `api_key`, `x-api-key`, in any case and with or without the underscore, followed by `:` or `=` | the value of a secret field in JSON, a query string or a header, of any length |
| 32 or more base64url characters in a row | any other long opaque token |

The last pattern over-redacts on purpose: a git SHA or a long hyphenated name is redacted
too. It does not catch an unlabelled opaque value that `+`, `/` or `.` breaks into runs
shorter than 32 characters, so redaction backs up the rule that a token is never put in a
message; it does not replace it.

## The `./node` subpath

```ts
import { discoverProfiles, readLoginState, readUsage, writeReading } from "@titan-design/anthropic-account/node";

for (const { label, configDir } of discoverProfiles()) {
  const login = readLoginState(configDir);
  const usage = readUsage(configDir);
  console.log(label, login.status, usage?.ageSeconds);
}
```

`discoverProfiles({ home?, env? })` returns `AccountProfile`s: `<home>/.claude` first, then
each directory under `<home>/.claude-profiles` in name order, each labelled by
`accountLabel`. A directory that does not exist is left out, and so is a symlink, at either
level. A non-empty `CLAUDE_CONFIG_DIRS` in `env` replaces the scan: its entries, split on
the path delimiter, are taken as given. `home` defaults to `os.homedir()` and `env` to
`process.env`.

`readLoginState(configDir, { now?, uid? })` reads `<configDir>/.credentials.json` and returns
`loginStateFromCredentials`'s `LoginState`. It never writes, chmods or refreshes. Before it
reads a byte it:

1. `lstat`s the path: absent gives `missing`, and a symlink or anything but a regular file
   gives `refused` with `not-a-regular-file`.
2. Opens it read-only with `O_NOFOLLOW` and `O_NONBLOCK`, so a symlink swapped in after the
   `lstat` fails the open (`not-a-regular-file`) and a FIFO cannot hang it.
3. `fstat`s the open descriptor and refuses unless it is a regular file with the `lstat`'s
   device and inode (`not-a-regular-file`), owned by `uid` (`foreign-owner`), with no group
   or other permission bits (`mode-too-wide`), with exactly one link (`hard-linked`), and at
   most 64 KiB (`malformed`).

A second hard link is refused because the file's other name may sit outside the config dir,
under rules this check cannot see. The read and the checks use the same descriptor, so the
file checked is the file read. The read stops at 64 KiB plus one byte. The buffer is zeroed
after parsing, and also when a read fails partway through. Invalid JSON is
`malformed`, and the parser's message, which quotes the input, is dropped. `uid` defaults to
the process's uid; on a platform without one every file is refused as `foreign-owner`. An
unexpected filesystem error is thrown through `redactSecrets`, with no `cause`.

`writeReading(configDir, reading)` writes `<configDir>/status-cache/sessions/usage-poll.json`
and returns its path. It throws a `TypeError` with a fixed message, and writes nothing,
unless the reading passes `parseUsageReading` with `session_id` `usage-poll` and its JSON
is unchanged by `redactSecrets`. Only the fields `parseUsageReading` keeps are written. The
write is atomic:

1. Creates the sessions dir, mode 0700, if needed.
2. Creates `.usage-poll.json.<pid>.<random>.tmp` in the same dir, exclusively, mode 0600.
3. Writes the JSON, `fsync`s, and closes.
4. Renames it over `usage-poll.json`, then `fsync`s the dir, best effort.

A reader sees the old reading or the new one, never part of one. The temp name does not
end in `.json`, so a reader that globs the dir never takes it. On a failure the temp file is
removed and the error is thrown through `redactSecrets`. agent-chat's status-line budget
reader accepts the file as written; a test restates its rules.

`readUsage(configDir, { now? })` returns `{ reading, file, ageSeconds }` for the reading with
the newest `written_at` across every `.json` file in the sessions dir, the poller's and each
status-line session's, or `null`. Each file goes through the same `lstat`, `O_NOFOLLOW` open
and `fstat` steps as the credentials file, without the owner, mode and link rules, so a
symlink or FIFO swapped in mid-read is refused and never blocks. A file is skipped when it
is not a regular file, is larger than 256 KiB (checked on the read itself, so growth after
the `fstat` counts), is invalid, or has no rate-limit window. Its `session_id`, `source` and
`account` pass through `redactSecrets`. `ageSeconds` is never negative.

## What it deliberately does not do

The root reads no files, makes no request and writes nothing. The `./node` subpath writes
only the usage file. Neither calls the usage endpoint yet, and neither refreshes a token.
Neither returns, logs or stores a token.

## Gotchas

`expiresAt` in credentials is epoch milliseconds, while a `UsageReading` uses epoch seconds.
A credentials expiry that looks like seconds is refused as malformed rather than read as long
expired. `accountLabel` names `.claude` `default` and otherwise uses the last path segment
without its leading dot, so two profile dirs with the same name get the same label.

## Where it came from

New. It is the pure core of account management as a tier-0 module. The status line,
agent-chat's budget readers and profiles, the pace pass and session-read are to consume it
and delete their own copies.

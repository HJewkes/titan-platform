# anthropic-account

**Tier 0.** No titan dependencies. `zod` is a peer dependency.

```sh
npm install @titan-design/anthropic-account zod
```

Status: 0.1, pure code. The root entry has no fs, process or network access, and a test
fails if it gains any. File and network access arrive later on a separate `./node` subpath.

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
  | { status: "refused"; reason: "malformed" | "mode-too-wide" | "foreign-owner" };
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
| `refused` | `malformed`: the block has no access token, or an expiry that is not epoch milliseconds |

`mode-too-wide` and `foreign-owner` are reserved for the `./node` reader, which refuses a
credentials file before reading it.

`needsRefresh(state, now, marginMs)` is true when the access token expires within `marginMs`
of `now`, or already has. It is false for `missing` and `refused`, which need a login, not a
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
`cause`. The original is left untouched.

| pattern | catches |
|---|---|
| `sk-ant-…` | OAuth access and refresh tokens and API keys |
| `eyJ….…(.…)` | JWTs |
| `Bearer …`, `Basic …` | an Authorization header value, of any length |
| `access_token`, `refreshToken`, `authorization`, `api_key`, `x-api-key` followed by `:` or `=` | the value of a token field in JSON, a query string or a header, of any length |
| 32 or more base64url characters in a row | any other long opaque token |

The last pattern over-redacts on purpose: a git SHA or a long hyphenated name is redacted
too. It does not catch an unlabelled opaque value that `+`, `/` or `.` breaks into runs
shorter than 32 characters, so redaction backs up the rule that a token is never put in a
message; it does not replace it.

## What it deliberately does not do

It reads no files, makes no request and writes nothing. It does not discover config dirs,
check a credentials file's mode, call the usage endpoint or refresh a token; those belong to
the `./node` subpath. It never returns, logs or stores a token.

## Gotchas

`expiresAt` in credentials is epoch milliseconds, while a `UsageReading` uses epoch seconds.
A credentials expiry that looks like seconds is refused as malformed rather than read as long
expired. `accountLabel` names `.claude` `default` and otherwise uses the last path segment
without its leading dot, so two profile dirs with the same name get the same label.

## Where it came from

New. It is the pure core of account management as a tier-0 module. The status line,
agent-chat's budget readers and profiles, the pace pass and session-read are to consume it
and delete their own copies.

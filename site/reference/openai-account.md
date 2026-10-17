# openai-account

**Tier 0.** Reuses `anthropic-account` secret redaction. TP-3363 read-side slice.

```sh
npm install @titan-design/openai-account
```

## The problem it solves

Read token-free Codex login state and quota observations without copying account
credentials. The pure root handles shapes and decisions; `./node` handles the
bounded status probe and read-only rollout scan.

## When to reach for it

Use this package for account admission and usage displays. Use `agent` to execute
a turn, `session-read` to decode transcripts and `anthropic-account` for Claude
accounts. Nothing here depends on the new Codex runtime adapter exports.

## Example

```ts
import { quotaAdmission } from "@titan-design/openai-account";
import { readLoginState, readUsage } from "@titan-design/openai-account/node";

const profile = { label: "reporter", codeHome: "/tmp/example-codex-home" };
const login = await readLoginState(profile);
const usage = await readUsage(profile);
const admission = quotaAdmission(usage, Date.now() / 1000);
// A supervisor must require both login.status === "present" and admission.allowed.
```

Tests use synthetic rollout fixtures and fake status executables, not installed
Codex or real account sessions. The status grammar and rollout shape target
0.162.1, but live CLI compatibility remains unverified under this seat's rules.

## Login and account selection

Every node read requires a safe label and explicit absolute `codeHome`. There is
no fallback to a shared account. `accountLabel(codeHome)` uses the final path
segment (`.codex` becomes `default`); labels accept only short non-secret
identifiers and cannot inject statusline delimiters.

`readLoginState(profile, options?)` runs only `codex login status`, with that
CODEX_HOME and API credential environment variables removed. It recognizes exact
ChatGPT success and not-logged-in output on either stdout or stderr. API-key
login and unknown formats refuse. It returns no raw stdout, stderr, path, token,
error or cause. Default timeout is five seconds; allowed override is 1–60000 ms.
An AbortSignal cancels the native probe. `runStatus` is a dependency seam for
tests and supervised transports, which must preserve those bounds.

Neither entry reads auth.json directly. This is not a login-health network check:
present means the CLI reports cached ChatGPT login, not that a model turn works.

## Rollout readings and age

`usageFromRolloutEvents(events, account)` recognizes `event_msg` /
`payload.type=token_count` with `payload.rate_limits`. It requires both numeric
windows: `used_percent` in [0,100], `window_minutes` 300 and 10080, plus future
epoch-second `resets_at`. Window order may be reversed. An explicit limit_id
must be `codex`; optional credits and other payload content are not returned.

The result is either `{ status: "known", reading }` or
`{ status: "unknown", reason }`. The reading contains only `account`,
`written_at` and `rate_limits.five_hour` / `seven_day` windows with
`used_percentage` and `resets_at`. All timestamps use **epoch seconds**, including
fractional observation seconds from native ISO timestamps.

Select the latest quota observation by event time across files. A newer bad
observation invalidates older evidence; conflicting equal timestamps, missing
timestamps and unexpected shapes refuse. Unknown fields never enter the reading.

`readUsage(profile, options?)` scans only `rollout-*.jsonl` in `sessions` and
`archived_sessions` beneath the selected home. No auth files, default-home scan
or network requests. Symlinks, hard links, nonregular rollouts, parse errors,
partial lines and scan failures return unknown/unreadable. The scan defaults to
64 MiB total, 4096 rollouts, 16384 directory entries and depth eight; bounds refuse
the entire scan rather than silently dropping newer files. `maxBytes` and
`maxFiles` can override their bounds. Large or concurrently appended transcripts
may therefore temporarily give unknown. Returned state never contains transcript
text or underlying errors.

## Quota admission

`quotaAdmission(result, now)` refuses automatic runs when weekly usage is **>86**
(less than 14 points remain), five-hour usage is **>=100**, the reading is missing
or inconsistent, or its age is **>900 seconds**. Exactly 86 weekly used and 900
seconds old are admitted if the other checks pass. Future observations and
already expired resets are inconsistent. No missing quota becomes zero. This
check does not include login state; supervisors check both.

Age is `now - written_at`; reading a file never refreshes that timestamp. The
local cache is an observation, not a live quota endpoint or account-wide spend
reservation. Additional model-specific pools are not admitted by this API.

## Statusline command

```sh
openai-account status --statusline [--code-home <absolute-dir>] [--account <label>]
```

Uses `--code-home` or explicit `CODEX_HOME`; never falls back to ~/.codex.
The label defaults to `accountLabel(codeHome)` and can be set with `--account`.
Only one selected account is read. No login probe, Codex binary, network or
credential read is needed. The command emits one line:

```text
codex|basement|20|75|12|
```

Five-hour and weekly columns are percentages **used**, rounded down, followed by
whole observation age in seconds and a trailing pipe. Zero is printed only for
an observed zero. Valid fresh readings exceeding admission thresholds still
show their percentages; the display does not admit a new run.

Missing, stale (age >900 before rounding), inconsistent, future, reset-expired or
unreadable evidence prints `codex|basement|unknown|unknown||`. No readable account
home gives `codex|default|unknown|unknown||` unless a safe account label was
explicitly supplied or derived. Invalid labels are never echoed; the line uses
`default` with unknown figures. A selected account cannot display another
account's labelled reading. Reader errors are dropped, with no transcript text
or errors on stderr. A valid statusline invocation always exits 0; syntax errors
exit 64 with fixed usage text. `--help` exits 0.

No renderer installation or dotfiles changes. For the Mac, which runs no Codex,
the external integration can fetch basement's output into a cache at most once
per 60 seconds. It must preserve reading age, expire stale cached evidence and
never make cached numbers appear fresh. That transport is outside this package.

## Scope and redaction

No credential provisioning, auth copying, login writes, token refresh,
permission adapter, runtime launch or account-wide reservation in this package.
`redactSecrets` reuses Titan's redactor and adds OpenAI key prefixes;
Error copies contain only scrubbed message/name/stack and no cause. Structural
allow-listing keeps transcript and status output out of account state altogether.

## Where it came from

New package for TP-3363, following `anthropic-account`'s pure root / node subpath
layout. The following slice adds only the statusline bin; renderers and transport
remain product integration work.

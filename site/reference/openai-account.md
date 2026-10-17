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

Use this package for account admission and usage displays with explicit evidence handling. Use `agent` to execute
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

The result is `{ status: "unknown", reason }` for native rollout evidence.
Codex can emit cached rate_limits on local token updates without fetching quota.
Even a single event, a changed value, or an identical re-emission cannot prove a
server observation time. Valid evidence therefore returns
`reason: "freshness-unverified"`, with no numbers, `written_at` or known age.
Displays must show unknown; admission refuses. No value-equality heuristic,
file mtime, read time or invented payload timestamp establishes freshness.

Validation still selects the latest evidence by event time across files. A newer
bad event invalidates older evidence; conflicting equal timestamps, missing
timestamps and unexpected shapes return inconsistent. No quota events returns
missing. Unknown fields never enter returned state.

The public `UsageResult` also supports a caller-supplied `{ status: "known",
reading }` for sources that independently establish quota observation time. That
reading contains `account`, `written_at` and `rate_limits.five_hour` / `seven_day`
windows with `used_percentage` and `resets_at`. All timestamps use epoch seconds.
The caller must establish the provenance; native rollout readers never produce known readings. The separate opt-in
backend reader below establishes a local request-start lower bound. Additional fields in raw rollouts
are not treated as a trusted timestamp seam.

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
or inconsistent, freshness is unverified, or its age is **>900 seconds**. Exactly 86 weekly used and 900
seconds old are admitted if the other checks pass. Future observations and
already expired resets are inconsistent. No missing quota becomes zero. This
check does not include login state; supervisors check both.

For caller-established observations, age is `now - written_at`. Native event
emission time cannot supply it, and reading a file never refreshes it. The
local cache is an observation, not a live quota endpoint or account-wide spend
reservation. Additional model-specific pools are not admitted by this API.

## Scope and redaction

No credential provisioning, auth copying, explicit
login writes, permission adapter, model turns or account-wide reservation. Native
backend quota reads can refresh native managed credentials implicitly. `redactSecrets` reuses Titan's redactor and adds OpenAI key prefixes;
Error copies contain only scrubbed message/name/stack and no cause. Structural
allow-listing keeps transcript and status output out of account state altogether.

## Where it came from

New package for TP-3363, following `anthropic-account`'s pure root / node subpath
layout. The explicit statusline opt-in below uses the authoritative reader.

## Opt-in native backend quota

```ts
import { readNativeUsage } from "@titan-design/openai-account/node";
// expectedAccountId comes from the supervisor account authority, not label/email.
const evidence = await readNativeUsage(profile, { expectedAccountId });
```

This is a separate explicit route; `readUsage` keeps its rollout-only behavior.
The reader resolves PATH Codex once to an absolute realpath, used for both version
and app-server. It probes >=0.162.1 with no maximum version pin, then requires
the native initialize and account-read protocol capabilities. Its private stdio
request sequence is initialize, initialized, account/read(refreshToken:false),
account/rateLimits/read(supportsLunaReserve:false,excludeResetCreditDetails:true),
account/read(refreshToken:false). It never requests login, token injection,
configuration writes, reset-credit consumption, a thread or a model turn.
Expected backend account binding is required before any child is started.
Native initialize must report the explicit selected home. A process environment allowlist
removes API keys, provider/account overrides and loader/shell injection variables. ChatGPT checks surround quota retrieval. A matching accountId,
ordinaryUsageAllowed:true and no account change across the read are mandatory.
Absent backend identity/readiness or unsupported method/shape refuses; a label,
email or older success cannot authorize a new read. Only the codex map bucket is
used, and its numeric windows must agree with the legacy codex snapshot.

`written_at` is local quota-request **start**, so network/validation delay counts
against the same 900-second Q5 ceiling. Backward/drifting wall clocks, excessive
duration and resets expiring in flight refuse. This is a conservative local
observation lower bound: official native source proves a new backend GET but
provides no server-internal snapshot generation time. Do not claim one. Native
sparse notifications and raw rollout timestamps never refresh it.

The default overall deadline is ten seconds (1–60000 ms), with cancellation and
bounded child output (stdout64 KiB, stderr16 KiB, line32 KiB, messages32). Fixed
unknown results replace raw protocol/errors; account IDs/email do not enter the
public reading. Native startup workspace discovery and managed credential
refresh can occur, including persistence of native-owned tokens. Deployment
policy must allow these effects; this library neither reads/copies credentials
nor supplies tokens itself.

Synthetic version/channel/child-stream fixtures verify protocol, quota and timing
rules; no live Codex, home, credentials, real sessions or backend was used.
Production runtime compatibility is UNVERIFIED, and no admission consumer is changed to use this route automatically.

Primary source: pinned [Codex 0.162.1 account processor](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/account_processor.rs#L1190-L1296),
[backend GET implementation](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/backend-client/src/client/rate_limit_resets.rs#L23-L79)
and [native credential refresh](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/login/src/auth/manager.rs#L2387-L2412).

Both native child operations run in one newly created empty temporary working
directory, never the caller project or account home. The owned directory is
removed on success, refusal, cancellation and startup failure (late creation is
cleaned after cancellation). CODEX_HOME remains the explicit selected account.
The default factory canonicalizes the created path and checks every physical
ancestor using metadata only. Any .git or .codex entry (file, directory or link),
or unknown/unreadable metadata, refuses and cleans the owned scratch directory.
This also rejects TMPDIR inside a checkout or project-config tree; custom root
markers cannot supply project layers without .codex in the pinned native loader.
Native global account configuration and credential refresh remain native-owned.
This is a preflight observation, not an OS read boundary: another process can
change ancestors after the check. No filesystem-race isolation is claimed.
Injected workspace/process/clock seams are for trusted tests or supervised
transports; callers must preserve these contracts when overriding them.

The ancestor rule follows pinned [native project discovery and layer paths](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/config/src/loader/mod.rs#L1492-L1539)
and [project .codex layers](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/config/src/loader/mod.rs#L1655-L1705).
A generic project-root-marker override is not equivalent to disabling project
config: managed discovery layers take precedence. No unsupported native
ignore-project flag is assumed, and no account-home configuration is disabled.

## Statusline command

`openai-account status --statusline --code-home /explicit/codex-home --account basement --expected-account-id <caller-binding>` opts into the authoritative native backend reader above. Native startup and managed credential refresh can occur. `--code-home` overrides explicit CODEX_HOME; no default home is scanned. The optional display label is never an identity binding. The expected account ID must come from the caller account authority, never a guessed home/label/email; missing or invalid binding emits unknown without launching native. It is not printed in output or errors.

Output remains exactly `codex|basement|20|75|12|`: used percentages and age are floored for display, with freshness checked before rounding. Fresh exhaustion still displays numbers; this is not admission. Unverified rollout freshness, stale (>900s), future, expired, mismatched, missing and failed evidence emits `codex|basement|unknown|unknown||`. Errors are fixed/quiet. Syntax errors exit64; valid display commands exit0. Tests use synthetic native seams; no real native/account execution or deployment is established by them.

Mac transport and renderer are separate product integration. Cache integrations must refresh no faster than60s and preserve a conservative age including transfer/local elapsed time; the integer display age is a lower bound and must not reset freshness.

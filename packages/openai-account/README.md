# @titan-design/openai-account

Read-only Codex account state: login status, rollout quota readings, freshness and admission

Tier 0 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

TP-3363 read-side slice. The root exports pure login-status parsing, account
labels, secret redaction, rollout quota selection and quota admission. `./node`
exports `readLoginState` and `readUsage`, both requiring an explicit absolute
`codeHome` and a safe account label. No account default or credential fallback.

`readLoginState` runs only `codex login status`, with a bounded timeout and API
credentials removed from its environment. ChatGPT login is recognized; an API-key
login, unknown output or failed probe refuses. Neither entry reads auth.json.

`readUsage` reads rollout JSONL under `sessions` and `archived_sessions` in the
selected home. It validates the latest token_count rate_limits evidence by event
time. Native Codex can re-emit cached quota during local token updates, so an
event timestamp does not establish a server observation time. Otherwise-valid
rollouts return `unknown/freshness-unverified`, without quota numbers or age.
Malformed, partial, conflicting or inaccessible evidence fails closed; no older
good reading replaces a newer bad one. Read failures return fixed reasons without
file contents, paths or underlying exceptions.

`quotaAdmission(result, now)` uses **epoch seconds**. Unknown freshness always
refuses. A known `UsageResult` requires `knownObservation({source, observedAt,
reading})`: the caller explicitly names the observation time source, and supplies
an account plus the two usage windows. For example, synthetic policy fixtures use
`source: "synthetic-independent-observation"` and their own clock, rather than a
rollout event timestamp. The factory validates the shape and copies the counters.

The factory records object identity in a module-private WeakSet and returns a
cloned, deeply frozen reading: both quota windows and their containers are immutable,
while caller-owned input stays mutable. A nominal TypeScript brand is type-only;
no reflected symbol or copied property can transfer runtime provenance. Plain
known literals, JSON round trips and shallow copies refuse admission. Mutation
cannot refresh the original observation time or lower a captured usage counter.
Serialization keeps the existing reading shape but does not preserve admission
provenance: a reader must reacquire evidence or explicitly attest its source again.
The source label is a caller assertion, not authenticated backend/account identity, a sandbox
boundary or proof that the supplied clock is truthful. A deliberate caller can
still explicitly attest a bad source; the factory prevents silent construction,
not dishonest callers. Backend producers must establish their own binding/fetch
requirements before calling it. Rollout validation never calls the factory.

Policy refuses weekly usage >86, five-hour usage >=100, age >900 seconds, future
timestamps and expired resets. Exact weekly used=86 and age=900 are allowed.
Malformed status/reading/window data and hostile getters return `inconsistent`
without throwing. Native rollouts never establish known freshness.

The pure root reuses `@titan-design/anthropic-account` secret redaction and adds
OpenAI key prefixes. No CLI, statusline, provisioning, login writes, token refresh,
permission enforcement or agent launch is included. Quota is a local observation,
not a reservation or a live server check. See the [reference](../../site/reference/openai-account.md).

## Opt-in backend quota read

`readNativeUsage(profile, { expectedAccountId })` from `./node` is separate from
`readUsage`: it requests fresh quota through native app-server private stdio.
It probes `codex --version` (minimum 0.162.1, newer versions require matching
initialize/account method schemas), then sends only initialize, initialized,
account/read (refreshToken:false), account/rateLimits/read, account/read.
The quota request opts out of Reserve and skips reset-credit details.
No login, token injection, config, thread, turn or model operation is requested.
The executable is resolved once to an absolute realpath for both version and app-server.
Only an allowlisted process environment is inherited (no API keys, provider/account
overrides or loader/shell injection variables); the home is explicit and checked in
initialize. Missing expected account binding refuses before spawning anything.

Only matching response `accountId`, `ordinaryUsageAllowed:true`, ChatGPT account
checks and an unchanged account generation can yield known quota. Labels/email
are not backend identity. The caller obtains expectedAccountId from its account
authority; this library does not parse auth.json to discover it. The codex bucket
must contain valid 300/10080 minute windows and agree with the legacy snapshot.
Missing/unsupported method/schema/identity, native errors, output overflow,
account changes, cancellation and timeout return fixed unknown results, without
raw stdout, stderr, paths, account IDs or error bodies.

The observation `written_at` is captured immediately before the native quota
request, so response and final account-check time count toward age. Wall and
monotonic clocks must agree (within one second); stale/expired responses refuse.
Source inspection proves a fresh native backend GET per read, not the backend
internal snapshot generation time. The server supplies no observation timestamp.
Sparse notifications, rollout emissions and prior successful responses never
refresh this clock. This is no quota reservation and other devices can spend it.

Native **may refresh and persist its own managed credentials** and perform
workspace discovery during startup, even with refreshToken:false on account/read.
Do not use this route where deployment policy forbids those native effects.
The package never directly reads/copies credentials or provisions accounts.
Default overall deadline is ten seconds (1–60000 ms allowed), stdout 64 KiB,
stderr 16 KiB, message 32 KiB and 32 messages. Process output is discarded at
teardown. An AbortSignal cancels both version probing and the owned app-server.

Tests inject version, connection or child streams and wall/monotonic clocks;
no real Codex/home/auth/session/backend is invoked. Production native runtime
compatibility remains unverified until separately authorized. No existing
rollout reader, statusline or automatic admission consumer is switched over.

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

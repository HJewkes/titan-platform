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

The factory adds a private, non-enumerable process-local brand binding `written_at`
to the attested `observedAt`. Plain known literals, JSON round trips, shallow copies
and attempts to refresh `written_at` by mutation refuse admission. Serialization
keeps the existing reading shape, but does not preserve admission provenance: a
reader must reacquire evidence or explicitly attest its source again. The source
label is a caller assertion, not authenticated backend/account identity, a sandbox
boundary or proof that the supplied clock is truthful. A deliberate caller can
still explicitly attest a bad source; the factory prevents silent construction,
not dishonest callers. Backend producers must establish their own binding/fetch
requirements before calling it. Rollout validation never calls the factory.

Policy refuses weekly usage >86, five-hour usage >=100, age >900 seconds, future
timestamps and expired resets. Exact weekly used=86 and age=900 are allowed.
Malformed status/reading/window data and hostile getters return `inconsistent`
without throwing. Native rollouts never establish known freshness.

The pure root reuses the import-free `@titan-design/agent-protocol/redaction`
implementation shared with anthropic-account, including OpenAI key prefixes. No CLI, statusline, provisioning, login writes, token refresh,
permission enforcement or agent launch is included. Quota is a local observation,
not a reservation or a live server check. See the [reference](../../site/reference/openai-account.md).

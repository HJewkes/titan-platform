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
refuses. For a caller-supplied known reading, the caller must independently
establish `written_at` as the quota observation time. Policy refuses weekly usage
>86, five-hour usage >=100, an age >900 seconds, future timestamps and expired
resets. Exact weekly used=86 and age=900 are allowed. This package currently has
no reader capable of establishing that known freshness from native rollouts.

The pure root reuses `@titan-design/anthropic-account` secret redaction and adds
OpenAI key prefixes. No CLI, statusline, provisioning, login writes, token refresh,
permission enforcement or agent launch is included. Quota is a local observation,
not a reservation or a live server check. See the [reference](../../site/reference/openai-account.md).

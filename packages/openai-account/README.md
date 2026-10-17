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
selected home. It selects the newest token_count rate_limits observation by its
event timestamp, not file mtime. Only five-hour and seven-day numeric quota
windows are returned. Malformed, partial, conflicting or inaccessible evidence
fails closed; no older good reading replaces a newer bad one. A read failure
returns a fixed reason without file contents, paths or underlying exceptions.

`quotaAdmission(result, now)` uses **epoch seconds**. It refuses weekly usage >86,
five-hour usage >=100, an age >900 seconds, future timestamps, expired resets and
missing/inconsistent evidence. Exact weekly used=86 and age=900 are allowed.
Reading age comes from the rollout, not the time this package reads it.

The pure root reuses `@titan-design/anthropic-account` secret redaction and adds
OpenAI key prefixes. No provisioning, login writes, token refresh, permission
enforcement or agent launch is included. Quota is a local observation, not a
reservation or a live server check. See the [reference](../../site/reference/openai-account.md).

## Statusline command

```sh
openai-account status --statusline --code-home /tmp/example-codex-home --account basement
```

`--code-home` overrides an explicit `CODEX_HOME`; there is no default-home scan.
`--account` overrides the label derived from the home's last path segment.
The command reads only the slice B rollout reader, with no login probe, Codex
launch, network request or write. It emits exactly one extra-account line:

```text
codex|basement|20|75|12|
```

Percentages are whole percentages **used**, rounded down like the Claude statusline;
age is whole seconds since the rollout observation. Fresh exhausted readings
still display their numbers: this is a display, not launch admission. Missing,
stale, inconsistent, future, expired or unreadable evidence emits
`codex|basement|unknown|unknown||`. Valid statusline invocations exit 0 with no
stderr. Invalid syntax exits 64 with fixed usage text. Unsafe account labels are
not echoed; they yield an unknown reading under the safe label `default`.

The command does not edit or install a renderer. A Mac without Codex can consume
a cached fetch of basement's output; the outer integration refreshes no faster
than once per 60 seconds and must retain observation age rather than treating
cached numbers as new evidence. That transport and dotfiles wiring are separate.

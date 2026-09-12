# @titan-design/hitl

## 0.1.2

### Patch Changes

- Updated dependencies [11b94a2]
  - @titan-design/store-sqlite@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [8153dd8]
  - @titan-design/store-sqlite@0.2.0

## 0.1.0

### Minor Changes

- aa9a762: Build the headless-agent and human-in-the-loop tiers.

  `@titan-design/agent` wraps the Claude Agent SDK's `query()` with the invariants the
  brain spike proved out: an environment scrub (anti-nesting vars, non-allowlisted
  `CLAUDE_CODE_*`, proxy leakage, and metered credentials unless `allowApiKeyBilling`),
  required `maxTurns`/`maxBudgetUsd` because the SDK defaults both to unlimited, an
  `apiKeySource` blacklist checked on the first `system/init`, an inactivity watchdog and
  external `AbortSignal` that both end through the SDK's abort path, structured output via
  `outputFormat: json_schema` re-validated with the caller's zod schema, and a failure
  taxonomy (`rate_limited | budget_exceeded | schema_invalid | max_turns | refusal |
auth_misconfigured | runtime_error | aborted | inactivity_timeout`) in place of thrown
  errors.

  `@titan-design/hitl` makes a paused task a row rather than a promise: `openGate` writes a
  gate any process can answer by id, `wait` polls until someone calls `resolveGate`, and the
  schema travels with the row as JSON Schema so the resolver can reject a bad payload
  without holding the original zod schema. `MemoryGateStore` and a `SqliteGateStore` over
  `@titan-design/store-sqlite` share one settle implementation and one behaviour suite.

### Patch Changes

- Updated dependencies [aa5f694]
  - @titan-design/store-sqlite@0.1.0

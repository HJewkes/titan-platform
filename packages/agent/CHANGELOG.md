# @titan-design/agent

## 0.4.1

### Patch Changes

- bb543d3: claude-print passes `maxTurns` to `--max-turns` instead of a fixed 1, raised to at least 2 when `outputSchema` is set, and reports `error_max_turns` as a retryable `runtime_error` (TP-371).

## 0.4.0

### Minor Changes

- 984e067: Add the `claude-print` harness to `runAgent`: `harness: "claude-print"` spawns headless `claude -p` on the CLI's own keychain login, so `CLAUDE_CODE_OAUTH_TOKEN` is not required. It runs one turn with no tools, hooks or MCP, passes `systemPrompt` as `--system-prompt` and `outputSchema` as `--json-schema` with a local zod re-parse, enforces the timeout and abort by killing the child process group, and still strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` unless `allowApiKeyBilling` is set. New exports: `AgentRunHarness`, `AuthEnvCheckOptions`, `CLAUDE_PRINT_UNSUPPORTED_OPTIONS`, `CLAUDE_PRINT_KILL_GRACE_MS`, `buildClaudePrintArgs`, `claudePrintCapabilities`, `resolveClaudeBin`.

## 0.3.0

### Minor Changes

- 09690de: `runAgent` accepts `tools` and `systemPrompt`, passed through to the SDK, so a call can run with no tools and a short system prompt.

## 0.2.0

### Minor Changes

- 11b94a2: Add bounded Codex execution, rollout discovery/decoding, and opt-in mixed-harness
  session ingestion with format-aware search excerpts and error readback. Preserve
  legacy Claude rows and references through additive conversation aliases. Prevent
  orphaned contentless FTS row IDs from leaking stale terms after source replacement.
  Recognize native shell missing-file diagnostics in error clustering.
- 25391fa: Add durable execution transitions and a transactional, lease-fenced execution ledger. Persist workflow dispatch identities and acknowledgments before waiting, and retain uncertain executions for explicit recovery rather than silently redispatching after restart.
- 3bde552: Add opt-in harness-neutral identity, usage, execution preflight and normalized session
  contracts for Claude/Codex integration. Existing Claude execution and transcript APIs
  retain their behavior. Codex execution, decoding and graph migration follow separately.

### Patch Changes

- Updated dependencies [25391fa]
- Updated dependencies [3bde552]
  - @titan-design/agent-protocol@0.1.0
  - @titan-design/agent-lifecycle@0.1.0

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

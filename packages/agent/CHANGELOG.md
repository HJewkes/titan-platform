# @titan-design/agent

## 0.7.0

### Minor Changes

- ff061ba: Codex app-server client: `CodexAppServer` now exposes `pid`, the spawned process id (also its process group id). The client, its types and its error classes (`startCodexAppServer`, `CodexSteerPreconditionError`, `CodexAppServerRpcError`, `CodexAppServerExitedError`) are exported from the package entry point.
- e8159b1: Add launch identity, per-agent TMPDIR and the orphan reap it depends on, ported from agent-chat: `withoutLaunchIdentity`, `ensureAgentTmpDir`, `removeOwnTmpDir`, `sweepAgentTmpDirs`, `reapOwnLaunch` and their process-table and filesystem seams.
- 211db45: A Claude adapter run that reaches its native `maxTurns` now fails as `limit_exceeded` (unit `agent_iterations`), and a Codex CLI refused by the version or capability check before spawn fails as `harness_mismatch`. Both used to be `runtime_error`, which the durable dispatcher parks in `recovery_required`; they now persist as terminal `failed`. `runtime_error` stays reserved for ambiguous transport loss, and `HarnessRunFailure` documents which kinds the dispatcher treats as ambiguous.
- 5e34e3d: Add `startCodexAppServer`, a typed client for `codex app-server` over stdio JSON-RPC: the initialize handshake, `threadStart`/`threadResume`, `turnStart` and `turnSteer`, turn and thread-status events, and exit handling that rejects pending calls. A steer that finds no matching active turn rejects with `CodexSteerPreconditionError`, so callers can fall back to `turnStart`.
- 869014a: `AgentUsage` gains an optional `cacheCreation` with the 5m and 1h cache write token split, read from the result's raw `usage.cache_creation`. It is absent when the harness gave no split.

### Patch Changes

- 9386796: Pass `CLAUDE_CODE_REMOTE` through `prepareEnv`, so a child `claude -p` run can skip the CLI's subagent warmup.
- cca108a: Clear the typed-lint baseline for most of the package: capability records are built key by key instead of cast, redundant casts and optional calls are gone, and test doubles use `partialFake`. No runtime behaviour change.
- 4ea511b: The claude-print harness now passes `--disable-slash-commands`, so a one-turn call loads no skills or commands and a prompt that opens with `/` is read as text.
- 2917ad8: A Codex version or help probe that throws before spawn (for example ENOENT when the CLI is not installed) now fails as `harness_mismatch` instead of `runtime_error`, so the durable dispatcher settles it as terminal `failed` rather than parking it in `recovery_required`. Probe timeouts and aborts keep their existing kinds.
- 9b42150: Use the shared `isRecord`, `isObjectLike` and `errorCode` from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
- Updated dependencies [211db45]
- Updated dependencies [5edd38d]
- Updated dependencies [646f4d7]
- Updated dependencies [fa4dd19]
- Updated dependencies [d46cbce]
- Updated dependencies [ae64085]
- Updated dependencies [ae64085]
- Updated dependencies [1bc6431]
- Updated dependencies [342c6ba]
- Updated dependencies [342c6ba]
- Updated dependencies [0100482]
  - @titan-design/agent-protocol@0.10.0
  - @titan-design/rpc-protocol@0.4.0
  - @titan-design/agent-lifecycle@0.1.10

## 0.6.2

### Patch Changes

- cda3cbe: Add a pure caller-bound Codex pricing port and optional quote-service injection in the Codex exec adapter. Preserve legacy pricing behavior, quote captured turn usage once across success/failure paths, and keep unpriced usage distinct from priced zero.
- Updated dependencies [cda3cbe]
  - @titan-design/agent-protocol@0.9.1

## 0.6.1

### Patch Changes

- 9914239: Extract SDK-free execution contracts into agent-protocol/harness with open harness identity parameters, preserving existing agent exports through compatibility aliases. This is the execution-only checkpoint of TP-3426; the remaining S01 ports are not implemented.
- 9914239: Expose the existing dated catalog and pricing arithmetic through the pure agent-protocol/pricing subpath and replace higher-tier implementations with compatibility exports, preserving model matching, TTL and inclusive token accounting.
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
  - @titan-design/agent-protocol@0.9.0
  - @titan-design/agent-lifecycle@0.1.9

## 0.6.0

### Minor Changes

- 9f24b7f: Discover Codex on PATH and require version 0.162.1 or newer with a bounded capability
  probe before every execution. Reject missing command/sandbox capabilities and any
  unverified extra MCP, policy or rollout requirements without starting a model.

### Patch Changes

- 108b7f4: Reject malformed Codex resume thread IDs before runtime probing and direct argv construction, preventing thread IDs from injecting CLI options.
- a79cffd: A `cancellation_unknown` execution terminal now carries the optional `usage` the harness reported before it was aborted, timed out or lost its cancellation acknowledgement, the same way a `failed` terminal does. `terminalFromHarnessResult` copies non-empty harness usage onto it and omits the key when nothing was spent.
- Updated dependencies [f4bd7c6]
- Updated dependencies [a79cffd]
  - @titan-design/agent-lifecycle@0.1.8
  - @titan-design/agent-protocol@0.8.0

## 0.5.0

### Minor Changes

- c54c098: `createCodexExecAdapter` accepts an optional dated `prices` table and fills turn usage with an estimated USD cost when the run's model has a row in force; without one, cost stays `null`. Exports `CodexPriceRow` and `priceCodexUsage`. The package ships no rates.

## 0.4.7

### Patch Changes

- ea3d34c: A failed `ExecutionTerminal` carries optional `usage`, and the durable dispatcher keeps the spend a harness reported before it failed, so budgets can count failed steps.
- Updated dependencies [ea3d34c]
  - @titan-design/agent-protocol@0.7.0
  - @titan-design/agent-lifecycle@0.1.7

## 0.4.6

### Patch Changes

- d020cf9: Reject `wallTimeMs` above the local timer range (2^31 - 1) in shared preflight, so Codex requests fail with `invalid_request` instead of firing their deadline at once.
- Updated dependencies [7345a13]
- Updated dependencies [f4b073d]
- Updated dependencies [ff6ff86]
  - @titan-design/agent-protocol@0.6.0
  - @titan-design/agent-lifecycle@0.1.6

## 0.4.5

### Patch Changes

- Updated dependencies [411b4f0]
  - @titan-design/agent-protocol@0.5.0
  - @titan-design/agent-lifecycle@0.1.5

## 0.4.4

### Patch Changes

- Updated dependencies [fe11f1b]
  - @titan-design/agent-protocol@0.4.0
  - @titan-design/agent-lifecycle@0.1.4

## 0.4.3

### Patch Changes

- Updated dependencies [b8a5614]
- Updated dependencies [d0ce38a]
  - @titan-design/agent-protocol@0.3.0
  - @titan-design/agent-lifecycle@0.1.3

## 0.4.2

### Patch Changes

- Updated dependencies [ca56251]
- Updated dependencies [18527b6]
- Updated dependencies [3f935f3]
- Updated dependencies [4761f82]
  - @titan-design/agent-protocol@0.2.0
  - @titan-design/agent-lifecycle@0.1.2

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

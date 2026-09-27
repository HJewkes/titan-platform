# @titan-design/agent-protocol

## 0.2.0

### Minor Changes

- ca56251: agent-protocol: add immutable namespaced `correlations` on `prepare` and `ExecutionRecord`, with `CORRELATION_KEY_PATTERN`, `RESERVED_CORRELATION_PREFIXES` (`broker`, `agent-thread`), `correlationKey` and `validateCorrelations` (TP-192 S3).
- 18527b6: agent-protocol: add the `ended` terminal outcome, the `observe_launched` transition and the exported `TERMINAL_EXECUTION_PHASES` tuple (TP-192 S1). workflow maps an `ended` settlement to a non-retryable failed step. agent-lifecycle derives its recoverable-phase filter from `TERMINAL_EXECUTION_PHASES`, so `ended` rows are never listed as recoverable.
- 3f935f3: agent-protocol: `reduceExecutionTransition` takes an optional `ExecutionReducerOptions` whose `fencing: { kind: "supervisor", lease }` fences transitions by a supervisor-wide lease, stamps accepted writes with it, and refuses per-row owner transitions (TP-192 S4). The default mode is unchanged.
- 4761f82: agent-protocol: add `fork` and `handoff` execution targets, `HandoffIdentity`, and an optional `pinnedNativeId` on `fresh` that `prepare` records as the execution's conversation (TP-192 S2).

## 0.1.0

### Minor Changes

- 25391fa: Add durable execution transitions and a transactional, lease-fenced execution ledger. Persist workflow dispatch identities and acknowledgments before waiting, and retain uncertain executions for explicit recovery rather than silently redispatching after restart.
- 3bde552: Add opt-in harness-neutral identity, usage, execution preflight and normalized session
  contracts for Claude/Codex integration. Existing Claude execution and transcript APIs
  retain their behavior. Codex execution, decoding and graph migration follow separately.

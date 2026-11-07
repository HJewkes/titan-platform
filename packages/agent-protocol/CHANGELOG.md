# @titan-design/agent-protocol

## 0.10.0

### Minor Changes

- ae64085: Add the `@titan-design/agent-protocol/lifecycle-schema` subpath: `executionRecordSchema`, `executionTransitionSchema` and the `ExecutionRecordSchema` / `ExecutionTransitionSchema` defaults, zod schemas for stored execution rows. Objects are loose, so keys a newer writer added survive a parse, and the `ExecutionRecord` / `ExecutionTransition` types are checked against them at compile time.
- 1bc6431: Add the `@titan-design/agent-protocol/source-schema` subpath: `SessionSourceDescriptorSchema`, `SourceTextLocatorSchema` and `UsageMeasurementSchema`, loose zod schemas for stored source descriptors, text locators and usage measurements. Keys a newer writer added survive a parse; `lifecycle-schema` now reads usage through the same schema.

  `session-graph` parses its stored columns with them. `readIndexedText` returns null for a malformed stored descriptor or locator list instead of throwing or reading through it. `normalizedUsage` skips a usage row that does not parse and reports it through a new `warn` option (default `console.warn`), so the remaining rows still sum. `zod` is now a peer dependency of `session-graph`.

- 342c6ba: `@titan-design/agent-protocol/wire` adds MCP argument schemas for the agent tools (spawn, resume, surface, list, profiles), the shared argument validators, and synthetic fixtures under `fixtures/wire/v1/`. The argument schemas strip unknown keys and carry no help text.
- 342c6ba: `@titan-design/agent-protocol/wire` carries agent-chat's spawn route fields: `agent_spawn` arguments gain optional `slice` and `route_override`, and the socket `spawn` frame gains optional `slice` and `routeOverride`. The v1 fixtures populate both.
- 0100482: Add `@titan-design/agent-protocol/wire`: zod schemas and types for agent-chat's spawn, resume, retire, agents and surface frames, and the profile, launch and roster records they carry. agent-surface gains a test that pins its `SURFACE_NAMES` to the wire copy.

### Patch Changes

- 211db45: A Claude adapter run that reaches its native `maxTurns` now fails as `limit_exceeded` (unit `agent_iterations`), and a Codex CLI refused by the version or capability check before spawn fails as `harness_mismatch`. Both used to be `runtime_error`, which the durable dispatcher parks in `recovery_required`; they now persist as terminal `failed`. `runtime_error` stays reserved for ambiguous transport loss, and `HarnessRunFailure` documents which kinds the dispatcher treats as ambiguous.
- 646f4d7: Clear the typed-lint baseline for agent-protocol: narrow instead of asserting, with no change to runtime behaviour.
- d46cbce: Bring `PRICE_TABLE` to version 5 against the 2026 published rates: add a dated `claude-sonnet-5-5` row for the $0.10/MTok cache read from 2026-10-07, add `claude-mythos-5-1` at Fable 5.1 rates, and price `claude-fable-5` cache reads at $1.00/MTok instead of Fable 5.1's $0.25.

## 0.9.1

### Patch Changes

- cda3cbe: Add a pure caller-bound Codex pricing port and optional quote-service injection in the Codex exec adapter. Preserve legacy pricing behavior, quote captured turn usage once across success/failure paths, and keep unpriced usage distinct from priced zero.

## 0.9.0

### Minor Changes

- 9914239: Add SDK-free execution service and request contracts with open harness IDs, account/profile binding references, structured output intent, an interface version and dispatch receipts distinct from completed results. Existing provider execution functions and compatibility types are unchanged.

  Add a neutral pricing port that keeps reported costs, dated catalog estimates and unpriced outcomes distinct, without adding a price table or changing existing arithmetic.

- 9914239: Allow neutral pricing ports to receive existing readonly cache-write TTL evidence and preserve source-provided estimates without relabeling them as reported or inventing catalog metadata.
- 9914239: Extract SDK-free execution contracts into agent-protocol/harness with open harness identity parameters, preserving existing agent exports through compatibility aliases. This is the execution-only checkpoint of TP-3426; the remaining S01 ports are not implemented.
- 9914239: Add SDK-free source-port contracts over the existing transcript DTOs, with plural nonempty found/expected-path lookups and explicit capability assessments. Existing source readers remain unchanged. This is a partial TP-3426 checkpoint and adds no runtime adapter or finality classifier.
- 9914239: Move the existing pure transcript source, observation and continuation declarations into agent-protocol/harness, preserving session-read compatibility exports and all decoder/read behavior. This is a further partial TP-3426 S01 checkpoint; account, pricing, policy and bus ports remain unfinished.
- 9914239: Expose the existing dated catalog and pricing arithmetic through the pure agent-protocol/pricing subpath and replace higher-tier implementations with compatibility exports, preserving model matching, TTL and inclusive token accounting.

## 0.8.0

### Minor Changes

- a79cffd: A `cancellation_unknown` execution terminal now carries the optional `usage` the harness reported before it was aborted, timed out or lost its cancellation acknowledgement, the same way a `failed` terminal does. `terminalFromHarnessResult` copies non-empty harness usage onto it and omits the key when nothing was spent.

## 0.7.0

### Minor Changes

- ea3d34c: A failed `ExecutionTerminal` carries optional `usage`, and the durable dispatcher keeps the spend a harness reported before it failed, so budgets can count failed steps.

## 0.6.0

### Minor Changes

- f4b073d: Key the trace redaction digest. `RedactTraceOptions` now takes a required `key`, and
  `redactTraceRecord` digests with HMAC-SHA-256 via Web Crypto instead of a bare SHA-256, so a
  redacted low-entropy field (a PR number, a line number, a repo name) can no longer be
  recovered by hashing guesses. A missing or empty key rejects. Digests now carry the
  `hmac-sha256:` prefix instead of `sha256:`, so an old unkeyed digest can't be mistaken for a
  new keyed one. Equal values still join within an export; exports join only when they share
  a key.

  Breaking for callers of `redactTraceRecord`, released as a minor under pre-1.0 rules.
  `git grep -l redactTraceRecord` finds 0 callers outside this package in titan-platform,
  active-work, agent-chat, codewatch, relay and brain.

### Patch Changes

- 7345a13: Keep a requested cancellation across a recovery: `observe_running` after `recovery_required` now returns phase `cancel_requested` instead of `running` when a cancellation was recorded.
- ff6ff86: Document that exports made with the old unkeyed `sha256:` digests do not join keyed `hmac-sha256:` ones. Docs only.

## 0.5.0

### Minor Changes

- 411b4f0: Add the `@titan-design/agent-protocol/worker-facts` subpath with `WorkerFactsSchema` and the `WorkerFacts` type: the contract for what a spawned worker's completion carries (agent, profile, spawner, task id, last Status or Verdict capped at 2,000 characters, PR, tokens, cost, exit code, signal and inferred).

## 0.4.0

### Minor Changes

- fe11f1b: `TRACE_STEP_KINDS` gains `authorize`, so an authorize step parses as a trace attempt.

## 0.3.0

### Minor Changes

- b8a5614: Add the `./trace` subpath: `titan.trace/v1` zod schemas for run, attempt, call, gate, artifact and cost records plus the envelope and `TranscriptSpan`, strict and loose parsers, the id helpers `commitRef`, `policyGateId` and `costId` with id patterns, `TRACE_FIELD_PRIVACY` and `redactTraceRecord`, and fixtures for a synthetic documentation run. `zod` 4 is an optional peer dependency; the root entry is unchanged and never imports it.
- d0ce38a: agent-protocol: export `foldUsage`, one pure fold that picks the `UsageMeasurement`s describing distinct spend (deltas deduplicated by `responseId` and superseding snapshots; the highest-sequence snapshot per scope, scope ID and epoch; a conversation snapshot superseding other scopes in its epoch) (TP-423).

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

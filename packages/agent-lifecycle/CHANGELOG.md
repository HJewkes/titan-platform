# @titan-design/agent-lifecycle

## 0.1.10

### Patch Changes

- fa4dd19: Clear the typed-lint baseline for the execution ledger: stored rows are read through a checked column reader instead of type assertions.
- ae64085: The SQLite execution ledger now parses stored snapshot, receipt and event rows with the agent-protocol lifecycle schemas and throws a clear `TypeError` on a malformed row instead of returning it unchecked. Unknown keys on a stored row are kept.
- Updated dependencies [211db45]
- Updated dependencies [c58d555]
- Updated dependencies [c1f9297]
- Updated dependencies [646f4d7]
- Updated dependencies [d46cbce]
- Updated dependencies [ae64085]
- Updated dependencies [1bc6431]
- Updated dependencies [342c6ba]
- Updated dependencies [342c6ba]
- Updated dependencies [0100482]
  - @titan-design/agent-protocol@0.10.0
  - @titan-design/store-sqlite@0.5.0

## 0.1.9

### Patch Changes

- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
  - @titan-design/agent-protocol@0.9.0

## 0.1.8

### Patch Changes

- f4bd7c6: `listRecoverable` selects with `phase IN` the non-terminal phases instead of `phase NOT IN` the terminal ones, so SQLite uses the `agent_execution_phase` index rather than scanning every finished execution.
- Updated dependencies [a79cffd]
  - @titan-design/agent-protocol@0.8.0

## 0.1.7

### Patch Changes

- Updated dependencies [ea3d34c]
  - @titan-design/agent-protocol@0.7.0

## 0.1.6

### Patch Changes

- Updated dependencies [7345a13]
- Updated dependencies [f4b073d]
- Updated dependencies [1f7de27]
- Updated dependencies [ff6ff86]
  - @titan-design/agent-protocol@0.6.0
  - @titan-design/store-sqlite@0.4.0

## 0.1.5

### Patch Changes

- Updated dependencies [ea96b66]
- Updated dependencies [f886302]
- Updated dependencies [411b4f0]
  - @titan-design/store-sqlite@0.3.3
  - @titan-design/agent-protocol@0.5.0

## 0.1.4

### Patch Changes

- Updated dependencies [fe11f1b]
  - @titan-design/agent-protocol@0.4.0

## 0.1.3

### Patch Changes

- Updated dependencies [b8a5614]
- Updated dependencies [d0ce38a]
  - @titan-design/agent-protocol@0.3.0

## 0.1.2

### Patch Changes

- 18527b6: agent-protocol: add the `ended` terminal outcome, the `observe_launched` transition and the exported `TERMINAL_EXECUTION_PHASES` tuple (TP-192 S1). workflow maps an `ended` settlement to a non-retryable failed step. agent-lifecycle derives its recoverable-phase filter from `TERMINAL_EXECUTION_PHASES`, so `ended` rows are never listed as recoverable.
- Updated dependencies [ca56251]
- Updated dependencies [18527b6]
- Updated dependencies [3f935f3]
- Updated dependencies [4761f82]
  - @titan-design/agent-protocol@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [e204012]
  - @titan-design/store-sqlite@0.3.0

## 0.1.0

### Minor Changes

- 25391fa: Add durable execution transitions and a transactional, lease-fenced execution ledger. Persist workflow dispatch identities and acknowledgments before waiting, and retain uncertain executions for explicit recovery rather than silently redispatching after restart.

### Patch Changes

- Updated dependencies [11b94a2]
- Updated dependencies [25391fa]
- Updated dependencies [3bde552]
  - @titan-design/store-sqlite@0.2.1
  - @titan-design/agent-protocol@0.1.0

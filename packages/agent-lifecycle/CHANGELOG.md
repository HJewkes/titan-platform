# @titan-design/agent-lifecycle

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

# @titan-design/agent-lifecycle

## 0.1.0

### Minor Changes

- 25391fa: Add durable execution transitions and a transactional, lease-fenced execution ledger. Persist workflow dispatch identities and acknowledgments before waiting, and retain uncertain executions for explicit recovery rather than silently redispatching after restart.

### Patch Changes

- Updated dependencies [11b94a2]
- Updated dependencies [25391fa]
- Updated dependencies [3bde552]
  - @titan-design/store-sqlite@0.2.1
  - @titan-design/agent-protocol@0.1.0

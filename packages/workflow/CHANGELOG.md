# @titan-design/workflow

## 0.2.0

### Minor Changes

- 25391fa: Add durable execution transitions and a transactional, lease-fenced execution ledger. Persist workflow dispatch identities and acknowledgments before waiting, and retain uncertain executions for explicit recovery rather than silently redispatching after restart.

### Patch Changes

- Updated dependencies [11b94a2]
- Updated dependencies [25391fa]
- Updated dependencies [3bde552]
  - @titan-design/agent@0.2.0
  - @titan-design/store-sqlite@0.2.1
  - @titan-design/hitl@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [8153dd8]
  - @titan-design/store-sqlite@0.2.0
  - @titan-design/hitl@0.1.1

## 0.1.0

### Minor Changes

- 403326f: Port brain's durable workflow runtime: memoized `dispatch` / `seed` / `assisted` steps over a
  SQLite run table, replay-on-restart via `hydrate`, human gates through `@titan-design/hitl`,
  an `agentRunner` over `@titan-design/agent`, signal parsing, and typed lifecycle events.

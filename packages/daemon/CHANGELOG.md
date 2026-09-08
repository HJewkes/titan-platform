# @titan-design/daemon

## 0.1.0

### Minor Changes

- 744fb7c: Extract the daemon host from active-work: a hono app serving `/health`, `/version`,
  `/events`, and `/rpc/:name`, with MCP spliced in at `/mcp`. Product concerns become
  parameters (`registry`, `createContext`, `stateDir`, `port`, `watchRoot`, `health`,
  `mountRoutes`, `formatError`, `logger`), and `startDaemon` returns a closable handle so the
  lifecycle is testable and never calls `process.exit`.

### Patch Changes

- Updated dependencies [48eace6]
  - @titan-design/registry@0.1.0

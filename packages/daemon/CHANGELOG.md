# @titan-design/daemon

## 0.1.1

### Patch Changes

- 87ae1ee: Destroy lingering sockets on shutdown so SIGTERM always terminates the process.

  `server.close` resolves only once every open connection ends, and an MCP or `/events`
  client holds one for its whole session, so a daemon could outlive SIGTERM indefinitely
  and leave its port held against a restart. `close` now sweeps idle connections at once
  and destroys the rest after `shutdownGraceMs` (default 2000).

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

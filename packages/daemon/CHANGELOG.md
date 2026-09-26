# @titan-design/daemon

## 0.3.0

### Minor Changes

- dede06c: The daemon's guards now refuse a state-changing request (POST, PUT, PATCH, DELETE, including `/rpc/:name` and `/mcp`) that carries neither an `Origin` header nor a non-empty `X-Titan-Client` header, with a 403. Before, a missing `Origin` skipped the origin check. Non-browser callers must add `x-titan-client: <name>`; `CLIENT_HEADER` is exported from `@titan-design/rpc-protocol` and re-exported by `@titan-design/daemon`, and `liveSource` in `@titan-design/rpc-client` now sends it. `GuardedRequest` gains a `client` field (TP-238).

### Patch Changes

- Updated dependencies [dede06c]
  - @titan-design/rpc-protocol@0.2.0
  - @titan-design/registry@0.3.1

## 0.2.0

### Minor Changes

- f2c70e0: Add `mountStaticApp(app, { root, base, immutableDir })` for the `mountRoutes` seam (TP-140). It serves a built front end, or a single-file build, under a path prefix. It sets content types, `nosniff`, immutable caching for hashed assets, and `no-cache` elsewhere. Client routes fall back to `index.html`, and a missing asset gets 404. The page answers 503 until the app is built. Traversal is refused, by encoded segment, by symlink, and for dotfiles. It registers `GET` only, behind the existing guards.

### Patch Changes

- cb3b7e2: The wire contract now comes from `@titan-design/rpc-protocol`. `registry` re-exports `JsonEnvelope`, `EXIT`, `successEnvelope`, and `errorEnvelope`, and `daemon` re-exports `SseMessage`, so existing imports keep working. The bytes on the wire are unchanged (TP-138).
- Updated dependencies [cb3b7e2]
- Updated dependencies [cb3b7e2]
- Updated dependencies [e3128f0]
  - @titan-design/registry@0.3.0
  - @titan-design/rpc-protocol@0.1.0

## 0.1.4

### Patch Changes

- 18e3cf0: Guard every daemon route with a Host allowlist, an Origin allowlist, and a JSON-only body
  gate. A `text/plain` POST from a cross-origin page, or a request whose `Host` names a
  rebinding attacker, previously reached the registry and ran the command.

## 0.1.3

### Patch Changes

- Updated dependencies [4ce40d1]
  - @titan-design/registry@0.2.0

## 0.1.2

### Patch Changes

- a69ca96: Use one recursive `fs.watch` on macOS and Windows instead of a handle per directory.

  Per-directory watching cost one FSEvents handle per directory, and each close is a
  semaphore round-trip serialized on the main thread: measured at 7.9ms across 1,593
  directories, which is 12.6s of a daemon's SIGTERM handler. Linux keeps the hand-rolled
  crawl, where recursive `fs.watch` is version-dependent. `isWatching` and `whenWatching`
  keep their meaning — "writes here reach the change feed" — which under a recursive root
  watch is any existing path beneath it.

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

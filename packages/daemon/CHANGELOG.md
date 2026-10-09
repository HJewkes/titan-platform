# @titan-design/daemon

## 0.5.0

### Minor Changes

- f8b7be1: Add session, login-code and bearer auth for a listener beyond loopback. New exports: `ensureTokenFile`, `rotateTokenFile`, `TokenFileError`, `mintLoginCode`, `consumeLoginCode`, `createLoginCodeLedger`, `signSession`, `verifySession`, `createDaemonAuth`, `authGate`, `mountAuthRoutes`, `getRequestAuth`, the constants `SESSION_COOKIE`, `LOGIN_PATH`, `LOGOUT_PATH`, `LOGIN_CODE_TTL_MS` and `SESSION_MAX_AGE_MS`, and the types `DaemonAuth`, `DaemonAuthOptions`, `LoginCodeLedger`, `RequestAuth` and `TokenFileProblem`. Login is two steps: `GET /auth/login?code=` renders an inert page, and its same-origin JSON `POST /auth/login` spends the code and sets the cookie. `createContext` now receives what the gate recorded as an optional second argument; nothing is gated by default, so loopback behaviour is unchanged.
- bf5cd2a: Add an authenticated remote listener. `startDaemon` takes `remote: { host, tokenFile, allowedHosts? }` and opens a second listener on that address and the same port. The loopback listener is unchanged. On the remote listener the Host/Origin guard and then the auth gate run before every route, Host and Origin match only with the bound port, and `/mcp` is never served. Both listeners bind or neither does, and `close()` shuts both. A loopback, wildcard or non-IP `remote.host`, or a remote listener beside an unauthenticated non-loopback `host`, throws the new `RemoteBindError`. New guard option `portOnly`. `RequestAuth` gains `peerLocal`, true when the peer is one of this machine's own addresses. New exports: `RemoteBindError` and the type `RemoteListenerOptions`.

### Patch Changes

- f88ac00: Answer a throwing `/mcp` handler with a JSON `errorEnvelope` (status 500, code `EXIT.SOFTWARE`) instead of a bare `String(err)` body.
- f320219: Fix a flaky port-conflict test: the first daemon now binds an ephemeral port instead of a probed one that a parallel test could take before the bind.
- 490489b: Split `watchTree` into small module-level helpers over a shared state object. Behavior is unchanged.
- ff6ff86: Pin in a test that closing a tree watcher clears its pending debounce timer. No runtime change.
- 37c2689: Add `EXIT.NOPERM` (77) and `RPC_STATUS.FORBIDDEN`. `rpcFailureStatus` maps a command that refuses its caller with `NOPERM` to 403, so `POST /rpc/:name` answers 403 for it instead of 500.
- 3c5b114: Add `EXIT.TEMPFAIL` (75) and `RPC_STATUS.TOO_MANY_REQUESTS`. `rpcFailureStatus` maps a command that refuses a caller over its limit with `TEMPFAIL` to 429, so `POST /rpc/:name` answers 429 for it instead of 500.
- d4ef157: Gate the daemon's built-in routes. `buildHttpApp` takes a `gate: DaemonAuth` option that runs right after the Host/Origin guard, so `/health`, `/version`, `/events`, `/rpc` and every `mountRoutes` route answer 401 without a credential; it also adds `POST /auth/logout`. The gate answers `/auth/login` itself (`GET`, `HEAD`, `POST`) and 405s every other method there, so a product catch-all can no longer receive them. On a gated app `/rpc` answers 401 rather than call `createContext` with no auth. `authGate` and `mountAuthRoutes` are no longer exported: mounting the gate inside `mountRoutes` or ahead of the guard left routes open. Ungated apps are unchanged.
- Updated dependencies [45f05b1]
- Updated dependencies [37c2689]
- Updated dependencies [3c5b114]
  - @titan-design/registry@0.3.3
  - @titan-design/rpc-protocol@0.3.0

## 0.4.1

### Patch Changes

- 179706a: Correct the watchTree platform-split docs and three stale comments (TP-1353, TP-1354).

## 0.4.0

### Minor Changes

- a20a6e3: `@titan-design/daemon` exports `getProcessStartTime(pid)`, which reads when a process started from `ps -o lstart=` in the C locale, or null when the pid has no process.

  `titan-factory service check` no longer reports a crash loop right after `service restart` or `launchctl kickstart -k`: a process under 5 minutes old whose `/health` body names the launchd pid is healthy, even though launchd recorded the killed run's non-zero exit. It reads process start time through the daemon helper instead of its own `ps` parser.

- 0e67551: `startDaemon` now rejects when the server fails to bind instead of raising an uncaught exception. A port already in use rejects with the new exported `DaemonPortInUseError` (carrying `port` and `host`); other bind errors such as `EACCES` reject with the original error.

## 0.3.3

### Patch Changes

- b62813c: `startDaemon` no longer refuses to start when the pid file names a live process that is not this daemon. After a reboot the OS can reuse the pid, which crash-looped supervised daemons. A live pid is treated as reused only when its start time is proven later than the pid file's mtime and the recorded port does not answer `/health`; the file is then logged as stale and removed. If the start time cannot be read, startup refuses and keeps the pid file. `StartDaemonOptions` gains an optional `processStartTime` seam.
- 3a4d4ed: Build README example paths from `os.homedir()`; Node never expands a literal `~`.

## 0.3.2

### Patch Changes

- Updated dependencies [1712421]
  - @titan-design/registry@0.3.2

## 0.3.1

### Patch Changes

- 17b952e: `startDaemon` now throws `NonLoopbackBindError` before binding when `host` is not loopback (127.0.0.0/8, `::1`, `::ffff:127.x.y.z`, `localhost`), because the daemon has no auth. The explicit `allowUnauthenticatedNonLoopback: true` option lifts the check; no environment variable does. `isLoopbackHost` is exported.

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

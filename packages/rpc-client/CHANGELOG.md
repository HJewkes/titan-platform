# @titan-design/rpc-client

## 0.4.2

### Patch Changes

- 9b42150: Use the shared `isRecord`, `isObjectLike` and `errorCode` from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
- 661cf66: Clear the typed-lint baseline for rpc-client: narrow parsed snapshots and envelopes instead of casting them. `parseSnapshot` now returns a validated copy rather than the parsed object itself.
- Updated dependencies [5edd38d]
  - @titan-design/rpc-protocol@0.4.0

## 0.4.1

### Patch Changes

- a914535: The test-fixture `registryCaller` and the README's in-process export snippet use registry's `inProcessCaller` instead of a hand-rolled lookup (TP-2464 b).

## 0.4.0

### Minor Changes

- 948d6de: Export `createSseParser`, the incremental `text/event-stream` parser the live source already uses, so a server that reads another daemon's `/events` can reuse it.

## 0.3.0

### Minor Changes

- f88ac00: Add an optional `onDialFailure` handler to `EventHandlers`. It receives `HTTP <status>` for a refused `/events` dial, or the fetch error's message, so a 403 Host refusal is no longer indistinguishable from a down daemon. A caller's own abort is not reported.

### Patch Changes

- Updated dependencies [37c2689]
- Updated dependencies [3c5b114]
  - @titan-design/rpc-protocol@0.3.0

## 0.2.0

### Minor Changes

- dede06c: The daemon's guards now refuse a state-changing request (POST, PUT, PATCH, DELETE, including `/rpc/:name` and `/mcp`) that carries neither an `Origin` header nor a non-empty `X-Titan-Client` header, with a 403. Before, a missing `Origin` skipped the origin check. Non-browser callers must add `x-titan-client: <name>`; `CLIENT_HEADER` is exported from `@titan-design/rpc-protocol` and re-exported by `@titan-design/daemon`, and `liveSource` in `@titan-design/rpc-client` now sends it. `GuardedRequest` gains a `client` field (TP-238).

### Patch Changes

- Updated dependencies [dede06c]
  - @titan-design/rpc-protocol@0.2.0

## 0.1.0

### Minor Changes

- e3128f0: New package (TP-139): a browser-safe typed client for titan daemons. `createRpcClient<M>` over a `DataSource`, with `liveSource` (`POST /rpc` plus SSE with reconnect and abort) and `staticSource` (a `titan-snapshot@1` file, answered from recorded calls or a dataset resolver). `exportSnapshot` in the `./node` entry writes the file.

### Patch Changes

- Updated dependencies [cb3b7e2]
  - @titan-design/rpc-protocol@0.1.0

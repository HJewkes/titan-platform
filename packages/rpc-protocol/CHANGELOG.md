# @titan-design/rpc-protocol

## 0.2.0

### Minor Changes

- dede06c: The daemon's guards now refuse a state-changing request (POST, PUT, PATCH, DELETE, including `/rpc/:name` and `/mcp`) that carries neither an `Origin` header nor a non-empty `X-Titan-Client` header, with a 403. Before, a missing `Origin` skipped the origin check. Non-browser callers must add `x-titan-client: <name>`; `CLIENT_HEADER` is exported from `@titan-design/rpc-protocol` and re-exported by `@titan-design/daemon`, and `liveSource` in `@titan-design/rpc-client` now sends it. `GuardedRequest` gains a `client` field (TP-238).

## 0.1.0

### Minor Changes

- cb3b7e2: New package: the dependency-free wire contract between a titan daemon and its clients. It holds `JsonEnvelope` with `successEnvelope` and `errorEnvelope`, the `EXIT` codes, the route constants (`RPC_PREFIX`, `EVENTS_PATH`, `HEALTH_PATH`, `VERSION_PATH`), the `/rpc` failure status mapping (`RPC_STATUS`, `rpcFailureStatus`), the SSE vocabulary (`SseMessage`, `SSE_EVENTS`, `SSE_READY_DATA`, `SSE_HEARTBEAT_MS`), and the `CommandMap` type. Browser-safe: no runtime dependencies and no Node imports (TP-138).

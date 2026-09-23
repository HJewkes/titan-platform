# @titan-design/rpc-protocol

## 0.1.0

### Minor Changes

- cb3b7e2: New package: the dependency-free wire contract between a titan daemon and its clients. It holds `JsonEnvelope` with `successEnvelope` and `errorEnvelope`, the `EXIT` codes, the route constants (`RPC_PREFIX`, `EVENTS_PATH`, `HEALTH_PATH`, `VERSION_PATH`), the `/rpc` failure status mapping (`RPC_STATUS`, `rpcFailureStatus`), the SSE vocabulary (`SseMessage`, `SSE_EVENTS`, `SSE_READY_DATA`, `SSE_HEARTBEAT_MS`), and the `CommandMap` type. Browser-safe: no runtime dependencies and no Node imports (TP-138).

---
"@titan-design/daemon": minor
---

`onRpc` on `HttpAppOptions` and `startDaemon` reports `{ name, ms, bytes, status, surface }` for every `/rpc` answer. `bytes` is the exact length of the body sent, an unknown command reports `(unknown)`, and a sample never carries arguments, ids or the body. An observer that throws is ignored, so telemetry cannot fail a call.

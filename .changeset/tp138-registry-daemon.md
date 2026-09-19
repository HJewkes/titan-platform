---
"@titan-design/registry": patch
"@titan-design/daemon": patch
---

The wire contract now comes from `@titan-design/rpc-protocol`. `registry` re-exports `JsonEnvelope`, `EXIT`, `successEnvelope`, and `errorEnvelope`, and `daemon` re-exports `SseMessage`, so existing imports keep working. The bytes on the wire are unchanged (TP-138).

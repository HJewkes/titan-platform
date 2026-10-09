---
"@titan-design/daemon": minor
---

Cap every `POST /rpc/:name` body before it is buffered. The cap is 1 MiB by default (`DEFAULT_RPC_BODY_LIMIT`). Set `rpcBodyLimit: { maxBytes, perCommand }` on `startDaemon` or `buildHttpApp` to change it for all commands or for one. A body over the cap gets 413, whether the client sent a `Content-Length` or streamed it chunked. The auth gate's record survives the request swap the limit makes, so a gated `/rpc` call still reaches `createContext` with its credential.

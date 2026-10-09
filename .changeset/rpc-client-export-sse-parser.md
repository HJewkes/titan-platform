---
"@titan-design/rpc-client": minor
---

Export `createSseParser`, the incremental `text/event-stream` parser the live source already uses, so a server that reads another daemon's `/events` can reuse it.

---
"@titan-design/rpc-client": minor
---

Add an optional `onDialFailure` handler to `EventHandlers`. It receives `HTTP <status>` for a refused `/events` dial, or the fetch error's message, so a 403 Host refusal is no longer indistinguishable from a down daemon. A caller's own abort is not reported.

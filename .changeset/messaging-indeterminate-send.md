---
"@titan-design/messaging": minor
---

Split "not sent" from "maybe sent" on `send`. `SendError` gains an `indeterminate` kind for a failure after the request may have reached the server: a reset or closed socket, a timeout or abort while awaiting the response, an unknown error shape, or a 2xx whose body could not be read. `unreachable` now means the request provably never left (DNS failure, refused connection, connect timeout, a request that could not be built), so it is the one kind that is safe to retry automatically. Breaking for exhaustive switches over `SendError["kind"]`: add an `indeterminate` arm and do not auto-resend on it.

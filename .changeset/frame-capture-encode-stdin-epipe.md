---
"@titan-design/frame-capture": patch
---

`startEncoder` now listens for `error` on ffmpeg's stdin. An ffmpeg that dies mid-encode rejects the pending `write` and `finish` with its exit reason (the EPIPE kept as `cause`) instead of crashing the process with an uncaught EPIPE, and a death between writes no longer leaves an unhandled rejection.

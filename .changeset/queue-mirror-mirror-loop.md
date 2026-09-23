---
"@titan-design/queue-mirror": minor
---

`runMirror` and `createMirror` project a `QueueSource` into the `#queue` room: each item is posted once under a deterministic txnId, the source cursor and /sync token are committed only after handling, owner reactions and replies to open approvable items resolve through the source, redacted or truncated items refuse phone verdicts, and every close (source, phone verdict or expiry) edits the item with `m.replace`.

# owner-queue: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You gather the things only the owner can answer from several stores of record (chat questions, hitl gates, task notes, review rounds) into one list and need one `OwnerItem` shape, a `QueueSource` port for adapters, a merge that joins duplicates only on an exact shared key including a PR's head sha, and a deterministic rank. The root export holds no I/O; the one exception is the `/spool` subpath, the 0600 file spool where agents file deposits and the console keeps the owner's answers. Other adapters live in the product, the gate itself is hitl, routing is decider, and mirroring to Matrix is queue-mirror.

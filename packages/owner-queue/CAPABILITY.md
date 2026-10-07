# owner-queue: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You gather the things only the owner can answer from several stores of record (chat questions, hitl gates, task notes, review rounds) into one list and need one `OwnerItem` shape, a `QueueSource` port for adapters, a merge that joins duplicates only on an exact shared key including a PR's head sha, and a deterministic rank. It holds no I/O: adapters live in the product, the gate itself is hitl, routing is decider, and mirroring to Matrix is queue-mirror.

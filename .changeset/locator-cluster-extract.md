---
"@titan-design/locator": minor
"@titan-design/cluster": minor
---

Extract the session miner's byte-offset provenance and Drain clustering from active-work.
`locator` ships the exact-offset JSONL reader, prefix and content hashes, the append-only
transcript table with resume detection, locator resolution, and content-addressed mirroring.
`cluster` ships the native Drain tree, per-partition registry, signature extraction, frozen
masks, deterministic template ids, and a storage-free `Clusterer` with snapshot/restore.

# @titan-design/cluster

## 0.1.2

### Patch Changes

- 11b94a2: Add bounded Codex execution, rollout discovery/decoding, and opt-in mixed-harness
  session ingestion with format-aware search excerpts and error readback. Preserve
  legacy Claude rows and references through additive conversation aliases. Prevent
  orphaned contentless FTS row IDs from leaking stale terms after source replacement.
  Recognize native shell missing-file diagnostics in error clustering.

## 0.1.1

### Patch Changes

- 49360c2: Describe what the package does rather than what was planned. The published description
  advertised an "optional DeepParse bootstrap"; `DEFAULT_MASK_CONFIGS` holds only `generic`
  and the bootstrap script has never been built. Masking is real and pluggable, so the
  description now says that.

## 0.1.0

### Minor Changes

- fbf473b: Extract the session miner's byte-offset provenance and Drain clustering from active-work.
  `locator` ships the exact-offset JSONL reader, prefix and content hashes, the append-only
  transcript table with resume detection, locator resolution, and content-addressed mirroring.
  `cluster` ships the native Drain tree, per-partition registry, signature extraction, frozen
  masks, deterministic template ids, and a storage-free `Clusterer` with snapshot/restore.

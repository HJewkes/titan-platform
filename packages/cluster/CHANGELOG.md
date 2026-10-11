# @titan-design/cluster

## 0.2.0

### Minor Changes

- 20b2ae2: Make signature anchor rules frozen data keyed by partition. `AnchorConfigs` and `DEFAULT_ANCHOR_CONFIGS` are exported; `ClustererOptions.anchors` and an optional third argument to `extractSignature` and `hasErrorSignal` let a consumer map its own partitions (for example `Bash`) onto the `test` or `git` rules. The defaults keep today's behavior for `test`, `git` and every other partition.

### Patch Changes

- fa2fb83: The generic `SHA` mask now requires a hex letter and a digit, so long decimal numbers resolve to `<NUM>` and all-letter hex words such as "defaced" stay unmasked. Template ids for lines containing either may change. Comments are rewritten in package terms, `toolType` parameters are renamed `partition`, and the unused `options` field on `Clusterer` is gone.

## 0.1.3

### Patch Changes

- 1b83b86: `DrainTree.insert` now reports the clusters it evicted in `MatchResult.evicted`, and `Clusterer` drops their template bindings, so `templateCount` and the snapshot's `templateIds` stay bounded by `maxClusters`. Loading an older snapshot prunes bindings for clusters it no longer holds. `isNewTemplate` now means no live cluster was bound to the id: a template whose cluster was evicted and recurs is reported new again, as it already was after a restore.
- fe76ae0: State the template-id contract as it is: ids are deterministic for a given input order and stable across restarts through snapshot and restore, and lines that Drain merges share the id of whichever line founded the cluster. No change to how ids are computed.

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

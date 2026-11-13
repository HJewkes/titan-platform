# @titan-design/retrieval-eval

## 0.1.0

### Minor Changes

- 51f9595: Discover transcripts through `@titan-design/session-read`, so `mine`, `uptake` and `served` now read subagent sidechains and honour `CLAUDE_CONFIG_DIRS`. The `defaultTranscriptRoots` and `discoverTranscripts` exports are removed; use session-read's `claudeTranscriptRoots` and `discoverAllTranscripts`.

### Patch Changes

- 7308e68: The `notes-fts` candidate reads `workspace_span` once a graph has been cut over, and the shared table before that or while a backfill is unfinished, so it no longer returns nothing after the cutover.
- d4ad311: Use the shared narrowing helpers from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
- aa345ae: Narrow transcript, search-response and ref-class reads instead of casting them.
- aa66e49: Validate pair files on read: a malformed line is skipped and the count logged to stderr
- 5a92f8f: A test pins that `served` labels a subagent sidechain's blocks against its parent's wrap record, and the README notes the corpus includes sidechains.
- Updated dependencies [f896485]
- Updated dependencies [42551ba]
- Updated dependencies [42b6a21]
- Updated dependencies [ed29ec2]
- Updated dependencies [1ac2768]
- Updated dependencies [5a67a0b]
- Updated dependencies [cfdfb64]
- Updated dependencies [ff6fb95]
- Updated dependencies [c58d555]
- Updated dependencies [6c3c967]
- Updated dependencies [d279098]
- Updated dependencies [f996bb9]
- Updated dependencies [6525ba7]
- Updated dependencies [f77d79d]
- Updated dependencies [5edd38d]
- Updated dependencies [9b42150]
- Updated dependencies [c2bfa21]
- Updated dependencies [a8bdbd2]
- Updated dependencies [98a2861]
- Updated dependencies [8436f35]
- Updated dependencies [aef50d8]
- Updated dependencies [cd8a1ce]
- Updated dependencies [c1f9297]
- Updated dependencies [5f2b39f]
- Updated dependencies [52dc7f3]
- Updated dependencies [78ae7d9]
  - @titan-design/session-read@0.17.0
  - @titan-design/retrieval@0.4.0
  - @titan-design/store-sqlite@0.5.0
  - @titan-design/embed@0.2.1
  - @titan-design/rpc-protocol@0.4.0

## 0.0.5

### Patch Changes

- 0b84d77: Take the `--active-root` and `--graph` defaults from `@titan-design/app-paths`, so they follow `ACTIVE_ROOT` and resolve off macOS. `defaultActiveRoot` and `defaultGraphPath` are removed; use `activeWorkRoot` and `activeWorkGraphPath` from `@titan-design/app-paths`.
- 82531b5: Reject unknown `--arm`, `--candidates` and `--variants` values with an error naming the allowed ones, and pass the already-read transcript heads to `mineSpawnArm`.
- Updated dependencies [cb137e3]
- Updated dependencies [5fe09ab]
- Updated dependencies [1f7de27]
  - @titan-design/app-paths@0.1.0
  - @titan-design/retrieval@0.3.1
  - @titan-design/store-sqlite@0.4.0

## 0.0.4

### Patch Changes

- d9a5c0f: Own the active-work workspace layout in one module, so an archived note hit from `hybrid-fts-vector` now matches the label mined from its `archive/` path and the served base rate lists archived initiatives too. `newestNotes` merges the legacy `notes/` and `sources/notes/` dirs before sorting by filename date instead of concatenating them.

## 0.0.3

### Patch Changes

- 7cefec9: Re-score REPORT.md against active-work 0.16.0 (spawn-arm R@10 0.203 to 0.272); no code change.

## 0.0.2

### Patch Changes

- 8d0cee3: Add the `served` arm: parses rendered bootstrap and spawn context blocks from transcripts and reports served, opened, opened-section and cited per class, initiative and file, with the unserved base rate (TP-330).

## 0.0.1

### Patch Changes

- Updated dependencies [e204012]
- Updated dependencies [3fea2d3]
- Updated dependencies [3e6a4af]
- Updated dependencies [3fea2d3]
  - @titan-design/store-sqlite@0.3.0
  - @titan-design/embed@0.2.0
  - @titan-design/retrieval@0.3.0

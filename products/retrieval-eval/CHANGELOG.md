# @titan-design/retrieval-eval

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

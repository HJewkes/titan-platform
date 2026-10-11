# @titan-design/evals

## 0.2.0

### Minor Changes

- 19fa0ef: Add the review outcome corpus: `titan-evals corpus` and `buildCorpus` write one row per reviewed head from the factory database, opened read-only, and git history, with the revert, main-red, later-fix, owner-override and fixer-changed-cited-paths labels and a derived escaped, caught, false-block, clean, pending or unresolved label.

### Patch Changes

- Updated dependencies [3bf2ac3]
- Updated dependencies [d7102a6]
- Updated dependencies [73683d7]
- Updated dependencies [7d52415]
- Updated dependencies [446c60a]
- Updated dependencies [5c659a3]
- Updated dependencies [dcf8e04]
  - @titan-design/session-read@0.12.0
  - @titan-design/session-analytics@0.11.0
  - @titan-design/review-panel@0.3.0

## 0.1.1

### Patch Changes

- d8ea373: Record the resolved champion hash in a new `titan.trial/v1` record and carry it into the scorecard key, so trials against different champions never share a key.
- 83588c9: Accept an exact model id with a final `[1m]` suffix, so a 1M-context variant can be registered. Vertex (`@`) and Bedrock (`:`) id forms are accepted too; bare aliases, mixed case, spaces and `-latest` are still refused.

## 0.1.0

### Minor Changes

- df4102e: Add the evals product scaffold: spec schemas for unit, variant, case, suite, check and scorecard with strict and loose parsing, canonical content hashing that covers referenced prompt files, a `titan-evals validate` command, and one synthetic fixture unit.

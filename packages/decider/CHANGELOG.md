# @titan-design/decider

## 0.1.0

### Minor Changes

- 90c09e0: New package: the owner-decision ledger's `LedgerRow` v2 schema (reads active-work's v1 precedent rows with `v` defaulting to 1), `classifyOutcome` (accept, amend, other, redirect, none) and `isExcluded`, which applies human-only initiatives, project-directory mapping and personal-data patterns passed in as data and flags rows with no resolvable initiative as unclaimed.
- a3a2f48: Add the ledger store and sources: `LedgerStore` (append-only by row key, a watermark per source cursor, on store-sqlite), the `LedgerSource` port `{ name, read(since) }`, `extractSource`, which drops excluded rows before writing, and `transcriptSource`, the `AskUserQuestion` source ported from active-work over session-read. The `LedgerSource` type naming a row's source is now `LedgerSourceName`. Scoring changes: a declined (`rejected`) question is unscored rather than `other`, a recommendation marker containing "recommend" is stripped whether prefix, suffix or bracketed, and a negated marker ("not recommended") no longer counts as the recommended option, and exclusion scans option descriptions for personal data.
- 72e9df4: Principles on `@titan-design/memory`: `principleBullet` (category is the domain, provenance is `ledger:<key>`), `feedbackForRow` and `applyFeedback` (owner answers become helpful or harmful feedback once per ledger key; decider answers, unclaimed and unparsed rows are skipped; overrules penalise the cited principles), `writePrincipleDocs` (one versioned markdown doc per domain with examples, counter-examples, confidence, last confirmed and changelog) and the frozen `ALWAYS_ASK` list with `alwaysAskList(hardStops)`.

### Patch Changes

- Updated dependencies [88bf9f7]
- Updated dependencies [c583709]
- Updated dependencies [f3f843d]
  - @titan-design/session-read@0.8.0

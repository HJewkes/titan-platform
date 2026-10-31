# @titan-design/evidence

## 0.5.0

### Minor Changes

- eaa03c2: `@titan-design/evidence/stats` adds `rocAuc` (Mann-Whitney, a tied pair counts half) and `aucInterval`, a seeded two-sample stratified percentile bootstrap that resamples whole clusters when cluster keys are given.

### Patch Changes

- 67aa361: Replace unchecked type assertions with narrowing; no behaviour change.

## 0.4.0

### Minor Changes

- 41fce70: Check a recommendation's cite against its transcript when the deposit is filed.

  - `@titan-design/evidence`: `quoteInText(text, quote)` matches a quote against any text. It normalises whitespace and line wrapping the same way `quoteInRange` does, and `quoteInRange` now calls it.
  - `@titan-design/owner-queue`: `recommended.cite` takes legacy free text or a strict `{session, event, quote}`, where `event` is `<byteOffset>:<byteLength>` of one transcript line (`locatorCiteSchema`, `LocatorCite`). A consumer that read `cite` as a string must now handle the object form too. `writeDeposit(dir, deposit, { events })` throws `DepositCiteError` and writes nothing for a locator cite whose quote does not match the event text, an event that cannot be read, an empty quote, or a call with no `events` source. Free text is never checked.
  - `@titan-design/session-read`: `readSessionEventText({session, byteOffset, byteLength}, { roots })` returns the message text of one whole Claude transcript line. It returns null when the session is not in exactly one transcript or the span is not one whole line.
  - `titan-console`: `inbox.deposit` checks locator cites through session-read and answers 400 when the check fails.

## 0.3.0

### Minor Changes

- 5cd4f1b: Add `parseAnchor` for `head/`, `base/` and `diff/` code anchors pinned to 40-hex commits, and `isFullSha` (TP-2766).
- abadd64: Add `verifyAnchorText`, `verifyRange` and `isAnchorForm`: check a pinned anchor's lines exist at its commit and quote them back (TP-2767).

## 0.2.1

### Patch Changes

- e54f34e: `wilson` returns exactly 0 for the lower bound at no successes and exactly 1 for the upper bound at all successes. The `sd` doc and the README paired-bootstrap example are corrected.

## 0.2.0

### Minor Changes

- a737546: New `@titan-design/evidence/stats` subpath: `wilson`, `betaBinomialInterval`, `bootstrapCI`, `pairedBootstrap`, `mcnemar` and `minimumDetectableEffect` for small-sample eval scoring. Bootstraps draw from `seededRandom` and are reproducible; no interval uses the normal approximation.

## 0.1.0

### Minor Changes

- 4a9eae9: New tier-0 package: `verifyCitation` checks a cited path, line range, shown lines and
  whitespace-normalized quote; `groupByOverlap` groups findings whose ranges share a line;
  `pickControls`, `placeControls` and `scoreControls` plant seeded controls and score
  per-label precision and recall. Lifted from the repo-review tools (TP-354).

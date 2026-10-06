# @titan-design/decider

## 0.5.0

### Minor Changes

- 81fbc08: `recommendsAuto` takes the category's overrule count and returns false at `DEMOTE_OVERRULES` (2) or more in the demotion window, so `score` no longer recommends `auto` for a category it flags for demotion, before or after `applyDemotions` runs. Callers of `recommendsAuto` must now pass `overrules`.
- ee207f6: `morningSource` takes an optional `resolveInitiatives` resolver. A row whose item names exactly one initiative is claimed for it, an item naming a human-only initiative is excluded, and any other row stays unclaimed. `joinMorning` returns the joined `items`, `onCounts` also reports `unresolved`, and `taskIdsIn` and `initiativesOfTaskIds` build a resolver from task ids.
- 660fc08: Export `taskIdsIn`, `initiativesOfTaskIds` and the `MorningInitiativeResolver` and `MorningDayCounts` types, so a caller can build a Morning resolver; the reference page and README now show `morningSource` with `resolveInitiatives`.
- feb9b78: Add `lintAsk`, a pure check of an owner question against the AskUserQuestion contract (rules AQ1 to AQ5: one decision, no bare ids, a `Now:` value, no pointer-only item, a recommendation), with `lintMorningList` and `lintOwnerQuestions` applying it per Morning item and per plan owner question. The Morning parser now keeps sub-item ids such as `vc-65.1` whole, in items and answers, so they never join item `vc-651`.
- 0119cf0: Add the `ask-lint <file> [--section <heading>] [--json] [--strict]` bin. It runs `lintMorningList` on the whole file, or `lintOwnerQuestions` on the one section `--section` names, and prints one `<item id> <rule> <evidence>` line per finding (one JSON object per finding under `--json`). It exits 0 by default, 1 under `--strict` when any finding exists, and 2 with one stderr line on a missing file or section heading.
- 1469a1d: Add a `bulk` outcome for one answer that accepts several decisions at once. `LedgerRow` gains `covers`, the number of decisions the answer covered when it can be read (null by default, so v1 and v2 rows still parse), and `bulk_from`, the outcome and count a row had before the bulk rule demoted it. Reading a row turns an `accept` or `amend` into `bulk` when the new pure `bulkSignal` detector fires: a source count above one, an accept word governing a batch of defaults ("accept the 9 defaults", "accept all recommended answers"), or an accept word taking a question range or count as its object ("yes to Q1-Q5"). One phrase rule reads the recommendation the owner adopted and the words they added, so a phrase gets the same answer wherever it appears. Every form of an accept word ("accepted", "approved", "ok to") finds one accepted object, with the lead-in stripped once, and every batch matcher reads that object. A negated or questioned accept word, a clause scoped with "only", a rate such as "10 questions per page", and keep, take or leave choosing a value are single decisions, as are a plain "Accept the defaults" and a count further on in the clause. `other`, `redirect`, `none` and null outcomes never change. A re-read restores `bulk_from` and applies the current rule again, so a stored demotion is never final.
- 604c9d8: Add `lintPrSection`, which checks an owner PR section for the PR URL (PR1), a what-it-does paragraph of at least two sentences (PR2), a why-asked line naming a gate class and a rule id (PR3), a pro and a con (PR4), and for a UI PR a before and after image pair per changed story or a stated reason there is none (PR5). Findings use the `AskFinding` shape of `lintAsk`, which now takes its rule id type as a parameter.

### Patch Changes

- 38cbdb4: `ExclusionSubject` and `SourceCandidate` take an optional `mentionedInitiatives` list; `isExcluded` excludes a row as `human-only-initiative` when any entry is human-only, and `extractSource` passes the candidate's list through. Rows without the list behave as before.
- b444f79: `lintAsk` stays linear on long tokens: the path and id-range patterns start at a token edge and an id's context is read from a bounded slice, so a 50 kB token or 7k distinct ids no longer take seconds. "Node.js" and "left/right/center" are no longer read as paths (AQ4), and "item(s)" no longer counts as a Principle enumerator.
- Updated dependencies [18e081a]
- Updated dependencies [ea96b66]
- Updated dependencies [218cbac]
- Updated dependencies [f886302]
- Updated dependencies [87e5857]
- Updated dependencies [d10a591]
  - @titan-design/session-read@0.9.0
  - @titan-design/store-sqlite@0.3.3
  - @titan-design/memory@0.1.3

## 0.4.0

### Minor Changes

- 48c201d: Add the Morning owner-answers source: `morningSource({ dir })` parses `<date>.md` lists and `<date>-owner-answers.md` answers, joins each answer to its item by number, and emits ledger rows with an outcome. Lines with no readable number, numbers naming no item, and bare numbers that fit several items are counted (`onCounts`), never guessed.
- b5b1d15: Add the shadow scorer: `score(predictions, ledger, { policy, now })` reports per-category agreement, missed redirects and the accept baseline, recommends `auto` when a category clears its graduation thresholds, and flags demotion on 2 overrules in 7 days; `applyDemotions` drops those categories back to shadow.

### Patch Changes

- 2e4ad03: Match a hard stop or human-only initiative that normalizes to empty on its raw text, so a symbol-only one such as `$` still routes to the owner queue. Policy rows that fold to one key now keep the most restrictive mode (off, then shadow, then auto).
- ed9b041: Morning join counts an item answered under two of its ids once, and reads hyphenated answer ids such as `ws-4: yes`.
- Updated dependencies [3a4d4ed]
  - @titan-design/store-sqlite@0.3.2

## 0.3.0

### Minor Changes

- be90944: Add `condense(store, rows, reflector)`: the condensation run. It feeds each domain's ledger rows since its watermark to an injected `Reflector`, validates the deltas with zod, records owner feedback (an overrule marks the decider's cited principles harmful; decider answers are never evidence), curates proposals as candidates, and can re-render the principle docs. Question text carrying an instruction can neither ground a principle nor confirm one.
- 6b4a8a6: Add `noteSource`, the decision-notes ledger source ported from active-work's `src/precedent/notes.ts`. It keeps v1's `note:<slug>/<file>` keys, writes `outcome: "none"` rows, and holds one watermark per note file so re-running extraction parses only changed notes.
- 2928bba: Add `route(question, policy, ctx)`, the deterministic owner-now, owner-queue or decider routing table, with per-category mode policy (`parseRoutingPolicy`, `setCategoryMode`) and agent-chat's unlock table (`checkUnlock`, `unlockTableRow`) ported with a parity fixture.

## 0.2.0

### Minor Changes

- d988182: Add the decide contract: `DecideInput` and `DecideReply` as zod schemas with JSON Schema output, and `validate(reply, input, policy)`, which rejects cited principle ids missing from the input and out-of-range option indexes, and forces escalation under the category's confidence threshold.

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

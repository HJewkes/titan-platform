# @titan-design/decider

## 0.4.0

### Minor Changes

- 48c201d: Add the Morning owner-answers source: `morningSource({ dir })` parses `<date>.md` lists and `<date>-owner-answers.md` answers, joins each answer to its item by number, and emits ledger rows with an outcome. Lines with no readable number, numbers naming no item, and bare numbers that fit several items are counted (`onCounts`), never guessed.
- b5b1d15: Add the shadow scorer: `score(predictions, ledger, { policy, now })` reports per-category agreement, missed redirects and the accept baseline, recommends `auto` when a category clears its graduation thresholds, and flags demotion on 2 overrules in 7 days; `applyDemotions` drops those categories back to shadow.

### Patch Changes

- ed9b041: Morning join counts an item answered under two of its ids once, and reads hyphenated answer ids such as `ws-4: yes`.

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

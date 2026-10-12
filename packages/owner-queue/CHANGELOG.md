# @titan-design/owner-queue

## 0.3.0

### Minor Changes

- 4a42590: Add `consolidate(open, { answered, heads, stacks, deps })`, which returns the approvals Flow: per-PR and topic groups, influence order, holds and a per-PR `shipBlockedBy`. Add `influenceEdges` and `INFLUENCE_RULES`.
- b7c53ee: Add `recheck(open, answered)`: drop an open item as `gone-elsewhere` when a newer answer on the same head shares its `ask:` key, and flag older shared answers as `conflict` or `reasked`. A shared component, token or topic only flags `related-answer` and never drops.
- 9c173c9: Add relation keys and round questions as items. `askKey`, `roundAskKey`, `componentKey`, `tokenKey` and `topicKey` build `ask:`, `component:`, `token:` and `topic:` keys that relate items without merging them (`isMergeKey` is unchanged and false for each); `relationKind` reads one back and `prKey` builds a canonical PR merge key. `fromRoundQuestions(manifest, roundId, { openedAt, bindings? })` reads each round@2 question as an open OwnerItem, and `answeredFromFeedback(feedback, manifest, { roundId, openedAt, bindings? })` returns the answered ones from a feedback@1 file. With `buildOwnerRounds` bindings a question maps back to the item and option ids it asked, so a built and answered round round-trips. An owner answer can now carry `optionIds` (pick-many), `changeRequested` (a feedback revision request, so an open change request blocks a ship) and `variantComments`.
- c174b71: Add `supersede(items, heads?)` and `stackContext(items, stacks)`. `supersede` withdraws open, answered or decided items pinned to a PR head other than the live one (`heads[pr]`, else the newest item's head) as `new-head:<sha>`, keeping their answers so an old change request stays readable as context without blocking a ship. `stackContext` gives each item on a stacked PR its base chain as context and orders it after the items on those bases.

## 0.2.0

### Minor Changes

- 9e29d34: Add `buildOwnerRounds(items, options)`: open Decide items become `titan-review/round@2` manifests that pass `RoundSchema` from `@titan-design/review-schema` (now a dependency). One question and section per ask in input order; items a principle covers become one `Principle:` question, and one-way items never batch. Items and principles are parsed first (an unparseable item is skipped as `invalid`), and every prompt, section text and option label is normalised to round@2's rules in one place. Asks with a shadow-mode item or a hidden pick, on an item or its principle, go in `after-answer` rounds; the rest go in `shown` rounds. Each round returns bindings from question ids and shown labels back to item and option ids. The zod peer range rises to `^4.3.6`, review-schema's own.

### Patch Changes

- c754254: `buildOwnerRounds` refuses invalid options before reading any item: a non-loopback `storybookUrl`, `widths` that are empty, repeated or outside 200 to 3840, a NaN, zero or negative `maxQuestions` or `firstRound`, or a blank `unit` throws a `ZodError`. Every manifest is parsed with `RoundSchema` before it is returned, so a returned round is always one round@2 accepts.
- 718eda8: Spool file names now escape A-Z, so `Bob` and `bob` no longer share a file on a case-insensitive filesystem. A lone surrogate in an asker, depositId or item id is refused with a `RangeError` rather than given U+FFFD's name. `writeDeposit` throws `SpoolNameCollisionError` instead of answering `created: false` when the name holds a different deposit. Deposits and answers filed under the old unescaped names are still read. `depositFileNames` and `answerFileNames` list both forms, and a repeat of an old deposit still answers `created: false`.

## 0.1.0

### Minor Changes

- 7313f6b: New package: the `OwnerItem` and `SourceRef` zod schemas, the `QueueSource` port, `mergeByKeys` (an exact shared key, including a PR's head sha, or no merge) and a deterministic `rank`. Pure, with no I/O.
- e963a49: Add `staleLabel(item, evidence)`: pure stale rules that label an open item `gone-elsewhere` when its PR merged, its pinned head moved, its task is done, or its asker retired after declaring an `onNoAnswer` default other than `parked`. Exports `STALE_RULES`, `PARKED` and the `StaleEvidence`, `StaleLabel` and `StaleRule` types.
- 4c1c075: Add the deposit format any agent can file into the owner inbox. `ownerItemDepositSchema` is a strict subset of `OwnerItem`: a deposit that carries `id`, `status`, `answer`, `route`, `authority`, `lint` or a hidden recommendation is refused, and `asker` and `depositId` (the idempotency key) are required. `fromDeposit(deposit, now)` parses a deposit and returns the open `OwnerItem` it files, with source `deposit:<asker>/<depositId>`, a lens derived from its kind (`DEPOSIT_LENS`) and an id from `depositItemId`. `SOURCE_SYSTEMS` gains `deposit`. Also exports the `OwnerItemDeposit` type.
- 5b53b87: Add the `@titan-design/owner-queue/spool` subpath, the on-disk store of record for deposits and their answers. `writeDeposit(dir, deposit)` validates against `ownerItemDepositSchema`, refuses a deposit over `MAX_DEPOSIT_BYTES` (64 KB), and files `<asker>-<depositId>.json` at mode 0600 through a temp file, once: a repeated `depositId` from one asker keeps the first file and returns `created: false`. `readSpool(dir)` returns every valid deposit as an open `OwnerItem` (opened at the file's mtime) plus a `rejects` list of `{ file, reason }`, and one bad file never stops the read. `writeAnswer(dir, id, answer)` and `readAnswer(dir, id)` keep `<id>.answer.json` beside the deposits. File names percent-encode every byte outside `[A-Za-z0-9_]`, so an untrusted asker or depositId cannot write outside the spool. The root export still does no I/O.

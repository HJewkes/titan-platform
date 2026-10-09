# @titan-design/owner-queue

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

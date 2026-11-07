# @titan-design/owner-queue

## 0.6.0

### Minor Changes

- d666020: Cap a seat at five open owner asks and key a deposit's blocking on its `unblocksNow` line (TP-4353). `inbox.deposit` (and so `titan-console inbox file`) refuses an asker's sixth open deposit with 429, listing the five open ids to merge or withdraw; answered and withdrawn deposits do not count, and the owner (`hjewkes` or `owner`) is never capped. Deposits gain an optional `unblocksNow`: one trimmed line of at most 200 characters saying what the answer unblocks right now. A deposit without it lists under Planning, never Blocking.

  Automation askers named in `TITAN_CONSOLE_CAP_EXEMPT_ASKERS` (a comma list of exact names, `titan-factory` when unset) skip the five-ask cap; their same-key alarms still fold into one item.

- 2c20516: Add an inbox withdraw verb and auto-withdraw self-healed alarms (TP-4112). owner-queue gains a `./withdraw` subpath (`withdrawDeposit`, `restoreDeposit`, `withdrawMatching`, `readWithdrawal`): a seat withdraws only its own deposit, with `<id>.withdrawn` beside it and never an answer file, and each withdraw and restore is appended to the spool's `withdrawals.jsonl`. It also gains `alarmKey`, `collapseRepeats` and an optional `repeats` on `OwnerItem`. `titan-console inbox withdraw|restore|withdraw-matching` exposes it (refusal 65, unknown id 66); the inbox lists withdrawn deposits apart from answered ones and collapses open repeats of one alarm into the newest. A verified console update withdraws its earlier update-failure items, and a factory deploy that holds withdraws the open deploy alarms and incidents, both as `resolved`.
- 5993fba: Let the owner approve a g10-held PR now and leave the merge to the adversary loop (TP-4003). A `merge-at-head` op may carry `waitFor: "adversary-loop"`. The factory then records a standing approval on the PR's Shepherd run, pinned to the confirmed head and to the g10 hold class the owner saw, and answers `approved`. The standing-answer sweep lifts the g10 hold as the owner once a g10 release Shepherd writes after the tap judges that hold met at that head, released or in shadow: the two-MERGE rule for `g10-adversary`, the single-MERGE release for `g10-review`. It then answers the run's approve-merge at that head. A new head, a hold escalated to another g10 class, a FIX_FIRST from the panel or the correctness reviewer, or expiry voids the approval and files a "Merge approval voided" owner inbox item. In the console, a g10-held merge-at-head shows "Merge without both MERGEs" (the forced merge, as before) beside "Approve; merge when the loop closes".
- 5cd2a5a: Add `OwnerOp`, the typed target of an owner action: `ownerOpSchema` is a strict union of `resolve-gate`, `release-hold`, `merge-at-head`, `close-pr`, `factory-config-set`, `deploy-pause-clear` and `retire-agent`. An item and a deposit may carry an optional `op`. `fromDeposit` adds the `pr:<repo>#<n>@<head>` key an op implies, so a deposit about a PR merges with that PR's item at the same head; it never derives a `gate:` key. `opKeys(op)` returns those keys.
- cda1b03: Add `buildPlanRound` (TP-4360): it turns one PR's predicted merge gates (ci-policy, skill, visual) into a questions-only round@2 round.json with a `planApprovals` block, which `titan-console decisions file -` takes as is. The owner's approve pick records each ask's task, repo, gate and scope as a plan approval.
- 6d79a8b: Add `promptLine` and `PROMPT_LINE_BREAK` to `@titan-design/owner-queue`: one cleaner for author- or agent-written text bound for an owner prompt, which drops ANSI escape sequences, C0 and C1 controls and every format character (bidi overrides and isolates, zero-width and tag characters) and flattens CR, LF, NEL, U+2028 and U+2029. The D21 ci-policy card, the console's decisions-file line and the Shepherd wake brief's review comments now all use it, so the decisions line also drops bidi and escape sequences, the wake brief strips them from comment paths and bodies (a verdict line behind a bidi override is now quoted), and the ci-policy card also drops tag characters and soft hyphens.
- 36e0a48: A deposit may carry an optional `blocker: { since, blocks }`, marking its asker as hard-blocked since a given time. It is allowed only on decide, approve and do deposits, `since` must be no more than 5 minutes ahead or 30 days behind the filing time, and a blocker deposit without `unblocksNow` takes `blocks` as its unblock line. Deposits without it parse unchanged.
- 20c93ed: Record who actually withdrew an inbox deposit (TP-4121). `withdrawDeposit`, `restoreDeposit` and
  `withdrawMatching` take a required `actor`, refuse a blank one, and write it beside the asker
  (`by`) in the `<id>.withdrawn` marker and every `withdrawals.jsonl` row. A marker from before
  this has no `actor` and still reads. `WithdrawnItem` gains an optional `actor`, which the
  console's inbox read model fills from the marker.

  `titan-console inbox withdraw|restore|withdraw-matching` take a required `--actor <seat>`; a
  missing one exits 65 with one line on stderr. The console updater and the factory deployer
  record their own names as actor when they auto-withdraw resolved alarms.

### Patch Changes

- a5f2f40: Let `withdrawDeposit` and `restoreDeposit` take a short deposit id (TP-4122). Besides the full
  `deposit:<32 hex>`, either takes a hex prefix of at least 8 digits, bare or after `deposit:`, that
  starts exactly one deposit in the spool, and reports the full id. An ambiguous prefix is refused
  with every full id it matches; no match is `unknown` with `unknown id <x>; full form is
deposit:<32 hex>`. Only an id of another item kind (`gate:`, `round:`) is refused as not a
  deposit. The asker, actor and answered checks run on the resolved deposit as before.

  `titan-console inbox withdraw|restore` pass the id through: an ambiguous prefix exits 65 and an
  unknown one 66.

- 7835f1b: Narrow thrown filesystem errors and round inputs by checking them instead of casting them.
- Updated dependencies [eaa03c2]
- Updated dependencies [67aa361]
  - @titan-design/evidence@0.5.0

## 0.5.0

### Minor Changes

- 41fce70: Check a recommendation's cite against its transcript when the deposit is filed.

  - `@titan-design/evidence`: `quoteInText(text, quote)` matches a quote against any text. It normalises whitespace and line wrapping the same way `quoteInRange` does, and `quoteInRange` now calls it.
  - `@titan-design/owner-queue`: `recommended.cite` takes legacy free text or a strict `{session, event, quote}`, where `event` is `<byteOffset>:<byteLength>` of one transcript line (`locatorCiteSchema`, `LocatorCite`). A consumer that read `cite` as a string must now handle the object form too. `writeDeposit(dir, deposit, { events })` throws `DepositCiteError` and writes nothing for a locator cite whose quote does not match the event text, an event that cannot be read, an empty quote, or a call with no `events` source. Free text is never checked.
  - `@titan-design/session-read`: `readSessionEventText({session, byteOffset, byteLength}, { roots })` returns the message text of one whole Claude transcript line. It returns null when the session is not in exactly one transcript or the span is not one whole line.
  - `titan-console`: `inbox.deposit` checks locator cites through session-read and answers 400 when the check fails.

### Patch Changes

- Updated dependencies [41fce70]
  - @titan-design/evidence@0.4.0

## 0.4.0

### Minor Changes

- cfc6614: Add an optional `audience` (`owner` | `operator`, absent means owner) to `OwnerItem` and `OwnerItemDeposit`, with `forAudience`/`audienceOf` and a `readSpool(dir, { audience })` filter, so a burndown can file operator steps without an `[operator]` summary prefix.
- 3e94b0b: Add optional owner card fields to `OwnerItem` and `OwnerItemDeposit` (`class`, `irreversible`, `shown`, `default`, `onSilence`, option `consequence`), plus `cardLint`, `ownerCardSchema`, `CARD_RULES` and `ON_SILENCE_ACTIONS`, so a card says what each answer costs and what happens on silence.
- abadd64: Items and options gain optional `anchors` and item `pins`; `writeDeposit(dir, deposit, { source })` refuses, unwritten, a deposit whose anchor is past EOF at its pinned commit (TP-2767).

### Patch Changes

- Updated dependencies [5cd4f1b]
- Updated dependencies [abadd64]
  - @titan-design/evidence@0.3.0

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

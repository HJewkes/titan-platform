# @titan-design/owner-queue

One list of everything waiting on the owner: the `OwnerItem` schema, the `QueueSource` port,
and merge-by-keys, rank and the review-round builder as pure functions.

Tier 2 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

- `ownerItemSchema` and `sourceRefSchema` (zod, a peer dependency) parse one item and the
  store of record it came from. `sources[0]` is the source an answer is forwarded to.
- `ownerItemDepositSchema` is what an agent may file: a strict subset of `OwnerItem` that
  refuses `id`, `status`, `answer`, `route`, `authority`, `lint` and a hidden recommendation,
  and requires `asker` and `depositId`. `fromDeposit(deposit, now)` parses one and returns the
  open item it files, with source `deposit:<asker>/<depositId>` and a lens taken from
  `DEPOSIT_LENS[kind]`. A repeated `depositId` from one asker yields the same item id.
- `@titan-design/owner-queue/spool` is the only part of the package that touches the
  filesystem; the root export stays I/O-free. `writeDeposit(dir, deposit)` files a deposit
  once as `<asker>-<depositId>.json` (0600, temp file then a no-clobber link, 64 KB cap),
  `readSpool(dir)` returns the valid items plus `{ file, reason }` rejects, and
  `writeAnswer`/`readAnswer` keep `<id>.answer.json` beside them. File names percent-encode
  every byte outside `[a-z0-9_]`, so no asker or depositId can name a path outside `dir`, and
  `Bob` and `bob` stay apart on a case-insensitive filesystem. A lone surrogate is refused.
  Readers still accept a deposit filed under its name from before A-Z was escaped.
- `QueueSource` is the adapter port: `open()`, `tail(cursor, signal)` and `resolve(ref, answer)`.
- `mergeByKeys(items)` joins items that share an exact key: `pr:<owner>/<repo>#<n>@<sha>`
  with the full 40-hex head sha (compared case-insensitively), `task:<id>`, `gate:<id>` or
  `run:<id>`. A PR key with no sha or a short sha never merges. Two items naming one PR stay
  apart, even through another shared key, unless both carry the same full head sha.
  `isMergeKey` says whether a key can merge at all.
- Relation keys relate items without merging them, so `isMergeKey` is false for each:
  `askKey(id)` (`ask:<id>`, one question across rounds; `roundAskKey(unit, questionId)` gives
  the default `ask:<unit>/<questionId>`), and `componentKey`, `tokenKey` and `topicKey`, whose
  names are lower-cased with spaces turned to `-`. A blank name throws. `relationKind(key)`
  returns `ask`, `component`, `token`, `topic` or null. `prKey(repo, pr, headSha)` builds the
  canonical PR merge key.
- `rank(items)` orders one-way items and blocking items routed `owner-now` first, then by how
  many keys an answer unblocks, then oldest first; ties group by initiative, then by id.
- `staleLabel(item, evidence)` returns `{ status: "gone-elsewhere", rule, reason }` or null for
  an open item, from a snapshot of source facts the caller read: `prs[<owner>/<repo>#<n>]`
  (state and head), `tasks[id].status`, `askers[name].retired` and `onNoAnswer[itemId]`. Rules,
  first match wins: `pr-merged` (`pr-merged:<pr>`), `head-moved` for a full-sha pin whose live
  head differs (`new-head:<sha>`), `task-done` (`task-done:<id>`) and `asker-retired`
  (`asker-retired:<asker>`), which fires only when the asker declared an `onNoAnswer` other
  than `parked`. A missing fact never labels an item.
- `supersede(items, heads?)` withdraws items pinned to an old PR head, because an approval
  resets on a new push. A PR's live head is `heads[<owner>/<repo>#<n>]` (case-insensitive, a
  full sha only), or else the head of its newest pinned item; on equal `openedAt` the later
  item wins. An `open`, `answered` or `decided` item pinned to another head is returned in
  `withdrawn` as `{ item, was, pr, reason: "new-head:<sha>" }`, with the item's status set to
  `withdrawn`. Other items stay in `kept`, in input order, and `heads` gives each live head.
  An unpinned or short-sha PR key pins nothing and is never withdrawn.
  **Change requests:** a withdrawn item keeps its answer, so a `changeRequested` against an
  old head stays readable as context, but it is no longer open and must not block a ship.
  Only a change request answered at the live head (a re-assertion) is in `kept` and blocks.
  Likewise an approval at an old head never counts as approval at the live head.
- `stackContext(items, stacks)` takes `stacks` mapping a stacked PR to its base PR, both
  `<owner>/<repo>#<n>` (case-insensitive). It returns `{ item, context }` for every item:
  `context` is the base chain of the item's stacked PRs, nearest first, shown as context and
  not under review. An item orders after every item on its bases; other items keep input
  order, and a cycle in `stacks` falls back to input order.
- `buildOwnerRounds(items, options)` turns open Decide items into `titan-review/round@2`
  manifests that pass `RoundSchema` from `@titan-design/review-schema`. It returns
  `{ rounds: [{ manifest, bindings }], skipped }`. Each ask is one question in its own section,
  in input order (rank first). Items a `Principle` covers become one `Principle:` question
  listing each; one-way items never batch. Asks whose items are all in `options.graduated`
  and carry no hidden pick (on an item or its principle) fill rounds with `"shown"`; the rest
  fill rounds with `recommendations: "after-answer"`. Items and principles are parsed first;
  an item that does not parse is skipped as `invalid`, and text questions carry no
  recommendation. Invalid options (a non-loopback `storybookUrl`, bad `widths`, a
  `maxQuestions` or `firstRound` below 1) throw, and each manifest is parsed with `RoundSchema`
  before it is returned. A `binding` maps each question id to its item ids and each
  shown option label back to the item's option id.
- `fromRoundQuestions(manifest, roundId, { openedAt, bindings? })` reads each question of a
  round@2 manifest as an open OwnerItem: id `round:<roundId>/<questionId>`, source
  `round:<roundId>#<questionId>`, the question's `ask:` key, and for a merge-bound pick-one the
  pinned `pr:` key, kind `approve` and lens `blocking-merge`. Other questions are `review`
  (`decide` when bound) with lens `planning`. With the bindings `buildOwnerRounds` returned, a
  single-item question takes its item's id and option ids; a principle stays a round item.
  `answeredFromFeedback(feedback, manifest, { roundId, openedAt, bindings? })` returns the
  same items for the questions a feedback@1 file answered, `answered` at `submittedAt` by
  `ROUND_ANSWERER`. A revision request becomes `changeRequested: true`, pick-many picks
  become `optionIds`, and variant comments are kept. Both parse with `ManifestSchema` and `FeedbackSchema` and throw on an
  invalid file or a feedback for another unit or round.

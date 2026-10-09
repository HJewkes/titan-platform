# @titan-design/owner-queue

One list of everything waiting on the owner: the `OwnerItem` schema, the `QueueSource` port,
and merge-by-keys and rank as pure functions.

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
- `rank(items)` orders one-way items and blocking items routed `owner-now` first, then by how
  many keys an answer unblocks, then oldest first; ties group by initiative, then by id.
- `staleLabel(item, evidence)` returns `{ status: "gone-elsewhere", rule, reason }` or null for
  an open item, from a snapshot of source facts the caller read: `prs[<owner>/<repo>#<n>]`
  (state and head), `tasks[id].status`, `askers[name].retired` and `onNoAnswer[itemId]`. Rules,
  first match wins: `pr-merged` (`pr-merged:<pr>`), `head-moved` for a full-sha pin whose live
  head differs (`new-head:<sha>`), `task-done` (`task-done:<id>`) and `asker-retired`
  (`asker-retired:<asker>`), which fires only when the asker declared an `onNoAnswer` other
  than `parked`. A missing fact never labels an item.

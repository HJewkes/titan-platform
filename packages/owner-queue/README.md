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
- `QueueSource` is the adapter port: `open()`, `tail(cursor, signal)` and `resolve(ref, answer)`.
- `mergeByKeys(items)` joins items that share an exact key: `pr:<owner>/<repo>#<n>@<sha>`
  with the full 40-hex head sha (compared case-insensitively), `task:<id>`, `gate:<id>` or
  `run:<id>`. A PR key with no sha or a short sha never merges. Two items naming one PR stay
  apart, even through another shared key, unless both carry the same full head sha.
  `isMergeKey` says whether a key can merge at all.
- `rank(items)` orders one-way items and blocking items routed `owner-now` first, then by how
  many keys an answer unblocks, then oldest first; ties group by initiative, then by id.

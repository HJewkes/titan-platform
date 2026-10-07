# @titan-design/owner-queue

One list of everything waiting on the owner: the `OwnerItem` schema, the `QueueSource` port,
and merge-by-keys and rank as pure functions.

Tier 2 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

- `ownerItemSchema` and `sourceRefSchema` (zod, a peer dependency) parse one item and the
  store of record it came from. `sources[0]` is the source an answer is forwarded to.
- `QueueSource` is the adapter port: `open()`, `tail(cursor, signal)` and `resolve(ref, answer)`.
- `mergeByKeys(items)` joins items that share an exact key: `pr:<owner>/<repo>#<n>@<sha>`,
  `task:<id>`, `gate:<id>` or `run:<id>`. A PR key without its head sha never merges, and two
  heads of one PR never merge even through another shared key. `isMergeKey` says whether a key
  can merge at all.
- `rank(items)` orders one-way items and blocking items routed `owner-now` first, then by how
  many keys an answer unblocks, then oldest first; ties group by initiative, then by id.

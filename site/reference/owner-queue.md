# owner-queue

**Tier 2.** No titan dependencies; `zod` is a peer dependency.

```sh
npm install @titan-design/owner-queue zod
```

## The problem it solves

Things that wait on the owner live in several stores of record: chat questions, approval
gates, task notes, review rounds. One decision often shows up in two or three of them, and
nothing says which copies are the same question. Answering one copy leaves the others open,
and a careless merge can carry an approval over to a commit nobody reviewed.

This package adds one item shape across every store and one merge rule. `OwnerItem` is the
row, `SourceRef` names the store it came from, and `mergeByKeys` joins items only when they
share an exact key. For a pull request the key includes its head sha.

## When to reach for it

Any product that collects owner asks from more than one source and renders them as one list,
whether a page, a status line or a phone push. Write one adapter per source against the
`QueueSource` port, merge the items, and rank them.

Neighbours: the gate itself and its resolution are [hitl](./hitl.md); who may resolve it is
[authority](./authority.md); whether the owner needs to see an item at all is `route` in
[decider](./decider.md); mirroring a queue into Matrix is [queue-mirror](./queue-mirror.md).

## Example

Verified against 0.1.0.

```ts
import { mergeByKeys, ownerItemSchema, rank, type OwnerItem } from "@titan-design/owner-queue";

const head = "pr:org-a/repo-1#12@a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const base = { kind: "approve", door: "two-way", context: "", personal: false, lens: "blocking-merge", unblocks: [], status: "open" } as const;

const gate: OwnerItem = ownerItemSchema.parse({
  ...base, id: "gate:g-1", sources: [{ system: "hitl", ref: "g-1" }],
  summary: "Merge org-a/repo-1#12", keys: [head], openedAt: "2026-01-01T00:00:00Z",
});
const ask: OwnerItem = ownerItemSchema.parse({
  ...base, id: "chat:m-1", sources: [{ system: "agent-chat", ref: "m-1" }],
  summary: "May I merge #12?", keys: [head, "task:PRJ1-7"], openedAt: "2026-01-01T01:00:00Z",
});

const list = rank(mergeByKeys([gate, ask]));
// one item, id "gate:g-1", sources [hitl g-1, agent-chat m-1], keys [head, "task:PRJ1-7"]
```

## Filing a deposit

Any agent can put an item in front of the owner by filing a deposit. `ownerItemDepositSchema`
holds only the fields an agent may set: `kind`, `door`, `summary`, `context`, `options`,
`recommended` (never hidden), `command`, `evidenceRef`, `keys`, `asker`, `seat`, `initiative`,
`personal`, `unblocks`, `expiresAt`, plus `depositId`. `asker` and `depositId` are required;
`keys` and `unblocks` default to empty and `personal` to false.

The schema is strict at every level. The system alone sets `id`, `status`, `answer`, `route`,
`authority`, `lint` and hidden picks, so a deposit carrying any of them is refused rather than
stripped. Unknown fields are refused the same way.

```ts
import { fromDeposit } from "@titan-design/owner-queue";

const item = fromDeposit(
  {
    depositId: "d-1", asker: "agent-a", kind: "decide", door: "two-way",
    summary: "Pick a cache layout", context: "Two layouts fit the read path.",
    options: [{ id: "flat", label: "Flat" }, { id: "nested", label: "Nested" }],
    recommended: { optionId: "flat", by: "agent-a" },
  },
  new Date("2026-01-01T00:00:00Z"),
);
// status "open", lens "blocking-agent", sources [{ system: "deposit", ref: "agent-a/d-1" }]
```

`fromDeposit` throws on a refused deposit, opens the item at `now`, and takes its lens from
`DEPOSIT_LENS`: `know` is `fyi`, `review` is `planning`, and every other kind is
`blocking-agent`, since an agent is waiting on the answer. The id is `depositItemId(asker,
depositId)`: `deposit:` and the first 32 hex characters of the SHA-256 of the JSON pair
`[asker, depositId]`. Filing the same `depositId` again yields the same id, so a retried deposit
names the item it already filed, and two askers using one `depositId` never collide.

## The deposit spool

The root export does no I/O. The `@titan-design/owner-queue/spool` subpath is the one
exception: a directory of files that is the store of record for deposits and the owner's
answers to them. Agents write it; the console and the factory read it.

```ts
import { readSpool, writeAnswer, writeDeposit } from "@titan-design/owner-queue/spool";

const dir = "/path/to/console-state/inbox/deposits";
await writeDeposit(dir, {
  depositId: "d-1", asker: "agent-a", kind: "know", door: "two-way",
  summary: "Nightly build moved to 02:00", context: "",
});
// { file: ".../agent%2Da-d%2D1.json", created: true }

const { items, rejects } = await readSpool(dir);
for (const item of items) {
  await writeAnswer(dir, item.id, { text: "ok", by: { class: "owner", id: "o", channel: "web" }, at: new Date().toISOString() });
}
```

- `writeDeposit(dir, deposit)` parses with `ownerItemDepositSchema` and throws on a refused
  deposit or one whose JSON is over `MAX_DEPOSIT_BYTES` (64 KB). It creates `dir` at 0700 if
  needed, writes a 0600 temp file and links it into place. A link, unlike a rename, refuses
  to replace an existing file, so the first write of an asker and `depositId` wins; a repeat
  returns `created: false` and changes nothing, even when many writers race.
- `readSpool(dir)` returns `{ items, rejects }`. Each valid deposit becomes an open item
  through `fromDeposit`, opened at the file's mtime. Invalid JSON, a schema failure, a file
  over the cap, a symlink, or a file whose name does not match its own asker and
  `depositId` goes to `rejects` as `{ file, reason }`; reasons never quote file contents. A
  missing `dir` reads as empty.
- `writeAnswer(dir, id, answer)` and `readAnswer(dir, id)` keep `<id>.answer.json` beside the
  deposits, written the same way. The first answer stays; `readAnswer` returns `undefined`
  when none is filed and throws on a malformed one.

File names come from untrusted values. `depositFileName(asker, depositId)` and
`answerFileName(id)` percent-encode every UTF-8 byte outside `[A-Za-z0-9_]`, so `/`, `\`,
`.`, `-` and NUL never reach the name raw. A name can never leave `dir`, `-` stays an
unambiguous separator (`a-b` + `c` and `a` + `b-c` get different files), and a name over 255
bytes is refused.

## What it deliberately does not do

- No I/O outside the spool subpath. Adapters, the projection store and the schedule belong to
  the product that runs them.
- No stale rules, routing or answer forwarding yet. Those land in later releases or in decider.
- No fuzzy matching. Two items that describe the same thing in different words stay apart
  until a source gives them a shared key.

## Gotchas

- `pr:org-a/repo-1#12` without `@<sha>` is a partial key and never merges, and a short sha
  never matches its full form. Emit the full head sha.
- Two items naming different heads of one PR stay apart even if they share a task key.
- The first item in input order is primary: its fields lead, and its `sources[0]` receives
  the answer. Put the source that should receive answers first.
- `rank` returns a new array and never filters; drop closed items before ranking if you
  only want open ones.

## Where it came from

New. The merge generalizes the factory digest's `keys` merge, and the port lifts
queue-mirror's `QueueSource` contract off its Matrix-shaped item so other renderers can
share it.

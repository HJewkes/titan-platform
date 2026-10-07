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

## What it deliberately does not do

- No I/O. Adapters, the projection store and the schedule belong to the product that runs them.
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

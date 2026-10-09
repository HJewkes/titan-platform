# owner-queue

**Tier 2.** Depends on `@titan-design/review-schema` (the round schema, from npm); `zod`
`^4.3.6` is a peer dependency.

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

## Stale rules

An item can stop being a question without anyone answering it: its PR merged, a new commit
moved the head it was pinned to, its task is done, or its asker retired and took its own
default. `staleLabel(item, evidence)` says so from facts the caller has already read; it does
no I/O and never guesses.

```ts
import { staleLabel } from "@titan-design/owner-queue";

const label = staleLabel(gate, {
  prs: { "org-a/repo-1#12": { state: "open", head: "0f1e2d3c4b5a69788796a5b4c3d2e1f098765432" } },
});
// { status: "gone-elsewhere", rule: "head-moved", reason: "new-head:0f1e2d3c4b5a69788796a5b4c3d2e1f098765432" }
```

| Rule | Fires when | Reason |
|---|---|---|
| `pr-merged` | any `pr:` key names a PR whose state is `merged` | `pr-merged:<owner>/<repo>#<n>` |
| `head-moved` | a `pr:…@<sha>` key pins a full sha and the PR's live head is a different full sha | `new-head:<sha>` |
| `task-done` | a `task:<id>` key names a task whose status is `done` | `task-done:<id>` |
| `asker-retired` | `askers[item.asker].retired` and the asker declared an `onNoAnswer` other than `parked` | `asker-retired:<asker>` |

- Rules run in that order and the first match wins, so a PR that merged on a newer head
  reads as merged.
- `onNoAnswer` is what the asker said it would do unanswered. A declared default means it
  has acted, so the question is gone. `parked`, or no declaration, means the work waits on the
  answer, so the item stays open for whoever resumes it.
- A missing fact (no entry for the PR, task or asker, or a short sha on either side) never
  labels an item. An item that is not `open` is never relabelled.
- PR refs and heads compare case-insensitively; `prs` uses the same `<owner>/<repo>#<n>`
  ref as a merge key without its `@<sha>`.

## Review rounds

`buildOwnerRounds(items, options)` turns the open Decide items of a queue into
`titan-review/round@2` manifests for the review harness. Every manifest passes `RoundSchema`
from `@titan-design/review-schema`; the package imports that schema rather than copying it.

```ts
import { buildOwnerRounds, rank } from "@titan-design/owner-queue";

const { rounds, skipped } = buildOwnerRounds(rank(open), {
  unit: "owner-queue",
  storybookUrl: "http://127.0.0.1:6006",
  graduated: ["naming"],
  principles: [{ id: "layout", rule: "The planner settles a cache layout when no reader sees it.", covers: ["chat:m-1", "chat:m-2"] }],
});
// rounds[i].manifest is round.json; rounds[i].bindings maps q1, q2, … back to item ids and option ids
```

| Option | Meaning | Default |
|---|---|---|
| `unit` | the round's unit name | required |
| `storybookUrl` | a loopback Storybook URL; round@2 needs one even with no frames | required |
| `firstRound` | the first round's number; later rounds count up | `1` |
| `widths` | frame widths | `[1280]` |
| `graduated` | categories out of shadow mode | none |
| `principles` | `{ id, rule, covers, recommended? }`: asks that share one reason | none |
| `maxQuestions` | questions per round; a principle counts as one | `10` |

- **Which items.** Open `decide` items not routed to the decider. Every other item comes
  back in `skipped` as `not-open`, `not-decide` or `routed-to-decider`.
- **Order.** One question and one section per ask, in input order, so rank first. A
  principle stands where its first covered item stood.
- **Batching (the question contract's rule 3).** Items a principle covers become one
  pick-one starting `Principle:`, stating the rule and listing each item as `(1) …; (2) …`,
  with options yes (the decider settles each by this rule) and no (ask each alone). A one-way
  item never batches. Each item goes to the first principle that covers it, and a principle
  left with fewer than two items, or with a blank rule, is not asked.
- **Shadow and graduated.** round@2 hides recommendations per round, not per question. An ask
  whose items all have a category in `graduated` goes in a round with
  `recommendations: "shown"`. Everything else, including an item with no category or a
  `hidden` recommendation, goes in a separate `"after-answer"` round. A principle is shadow
  if any item it covers is.
- **Questions.** An item with options is a pick-one: each option reads `label: description`,
  the item's summary is the prompt and the `signsOff`, and the decider's pick becomes the
  recommendation when it has a confidence and a rationale (or a cite, shown as `Cite: …`).
  An item without options is a text question. round@2 refuses an option label shared by two
  questions, and a blanket sign-off such as "Approve" or "LGTM" in any prompt or label, so such
  text gets ` (q<n>)` appended until it is neither; no option is ever dropped.
- **Bindings.** `bindings[i]` is `{ questionId, itemIds, principleId?, options }`, where
  `options` maps each shown label to the item's option id (`yes` or `no` for a principle), so
  feedback can be routed back to each item.

## What it deliberately does not do

- No I/O outside the spool subpath. Adapters, the projection store and the schedule belong to
  the product that runs them. Stale rules read evidence the caller fetched.
- No routing or answer forwarding yet. Those land in later releases or in decider.
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

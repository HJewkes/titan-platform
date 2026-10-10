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
`answerFileName(id)` percent-encode every UTF-8 byte outside `[a-z0-9_]`, so `/`, `\`,
`.`, `-` and NUL never reach the name raw. A name can never leave `dir`, `-` stays an
unambiguous separator (`a-b` + `c` and `a` + `b-c` get different files), and a name over 255
bytes is refused. Uppercase letters are escaped too, so `Bob` and `bob` get different files
even on a case-insensitive filesystem. A value holding a lone surrogate is refused with a
`RangeError`: UTF-8 would turn it into U+FFFD and give it the name of a value that really
holds U+FFFD.

Before uppercase letters were escaped, `Bob` was filed as `Bob-…json`. `depositFileNames` and
`answerFileNames` list the current name first and that legacy name second, and every reader
accepts both: `readSpool`, `readAnswer`, and the repeat check in `writeDeposit` and
`writeAnswer`. Writers only ever create the current name. When a name is already taken,
`writeDeposit` reads the file there and throws `SpoolNameCollisionError` unless it holds the
same asker and `depositId`. It never answers `created: false` for an id it did not file.

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

## Supersede and stacked context

GitHub and GitLab reset an approval when a new commit is pushed, so an answer pinned to an
old head of a PR must not approve the new one. `supersede(items, heads?)` applies that rule
across the queue, and `stackContext(items, stacks)` labels the base of a stacked PR as context.

```ts
import { stackContext, supersede } from "@titan-design/owner-queue";

const { kept, withdrawn, heads } = supersede(items, { "org-a/repo-1#12": liveHeadSha });
// withdrawn[i] is { item, was, pr, reason: "new-head:<sha>" }

const ordered = stackContext(kept, { "org-a/repo-1#13": "org-a/repo-1#12" });
// each item on #13 has context ["org-a/repo-1#12"] and comes after the items on #12
```

- **Live head.** `heads[<owner>/<repo>#<n>]` when it is a full 40-hex sha, else the head of
  the PR's newest pinned item by `openedAt`; on a tie the later item in input order wins. PR
  refs and shas compare case-insensitively.
- **Withdrawn.** An `open`, `answered` or `decided` item with a `pr:…@<sha>` key on another
  head comes back in `withdrawn` with status `withdrawn`, its earlier status in `was`, and
  `reason` `new-head:<live sha>`. Every other item stays in `kept`, in input order. An item
  that is already closed, or whose PR key has no sha or a short one, is never withdrawn.
- **Change requests.** A withdrawn item keeps its `answer`. A `changeRequested` on an old head
  therefore stays readable as context, but it is not open and does not block a ship at the new
  head. It blocks again only when re-asserted: answered with `changeRequested` at the live
  head, which keeps the item in `kept`. An approval at an old head never counts at the new one.
- **Stacks.** `stacks` maps each stacked PR to its base. An item's `context` is the base chain
  of its own PRs, nearest first (`#c` on `#b` on `#a` gives `[#b, #a]`); a PR the item itself
  names is never its context. Items on a base come before the items stacked on it; unrelated
  items keep input order, and a cycle in `stacks` falls back to input order.

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
| `unit` | the round's unit name, not blank | required |
| `storybookUrl` | an http(s) URL on `127.0.0.1`, `localhost` or `[::1]`; round@2 needs one even with no frames | required |
| `firstRound` | the first round's number, an integer of at least 1; later rounds count up | `1` |
| `widths` | frame widths, distinct integers from 200 to 3840 | `[1280]` |
| `graduated` | categories out of shadow mode | none |
| `principles` | `{ id, rule, covers, recommended? }`: asks that share one reason | none |
| `maxQuestions` | questions per round, an integer of at least 1; a principle counts as one | `10` |

- **Configuration errors throw.** Options outside the table's rules throw a `ZodError` before
  any item is read, and every manifest is parsed with `RoundSchema` before it is returned, so
  a returned round is always one round@2 accepts. Item and principle problems never throw;
  they are skipped as below.

- **Which items.** Every item is parsed with `ownerItemSchema` first, and every principle with
  its own schema, so a value only its TypeScript type vouches for never reaches a round. Open
  `decide` items not routed to the decider are asked. Every other item comes back in `skipped`
  as `invalid`, `not-open`, `not-decide` or `routed-to-decider`; a principle that does not
  parse, such as one with a blank rule, is not asked.
- **Order.** One question and one section per ask, in input order, so rank first. A
  principle stands where its first covered item stood.
- **Batching (the question contract's rule 3).** Items a principle covers become one
  pick-one starting `Principle:`, stating the rule and listing each item as `(1) …; (2) …`,
  with options yes (the decider settles each by this rule) and no (ask each alone). A one-way
  item never batches. Each item goes to the first principle that covers it, and a principle
  left with fewer than two items is not asked.
- **Shadow and graduated.** round@2 hides recommendations per round, not per question. An ask
  whose items all have a category in `graduated` goes in a round with
  `recommendations: "shown"`, unless the ask carries a `hidden` recommendation on an item or
  on its principle. Everything else, including an item with no category, goes in a separate
  `"after-answer"` round.
- **Questions.** An item with options is a pick-one: each option reads `label: description`,
  the item's summary is the prompt and the `signsOff`, and the decider's pick becomes the
  recommendation when it has a confidence and a rationale (or a cite, shown as `Cite: …`).
  An item without options is a text question and carries no recommendation.
- **Text round@2 is strict about.** Every prompt, section text and option label passes one
  normaliser: it trims, replaces blank text with a fallback (a blank summary reads "An ask with
  no summary"), and appends ` (q<n>)` until the text is neither a blanket sign-off such as
  "Approve" or "LGTM" nor an option label already in the round. No option is ever dropped. A
  seeded property test feeds adversarial items and principles through and checks every
  manifest against `RoundSchema`.
- **Bindings.** `bindings[i]` is `{ questionId, itemIds, principleId?, options }`, where
  `options` maps each shown label to the item's option id (`yes` or `no` for a principle), so
  feedback can be routed back to each item.

## Relation keys

Some items are about the same thing without being the same item: one question asked again in
a later round, or two asks about one shared component. Relation keys record that. None of them
is a merge key, so `mergeByKeys` never joins items on one; the approval flow reads them to
re-check, group and order items instead.

| Helper | Key | Meaning |
|---|---|---|
| `askKey(id)` | `ask:<id>` | the same question across rounds |
| `roundAskKey(unit, questionId)` | `ask:<unit>/<questionId>` | a round question's default ask key |
| `componentKey(name)` | `component:<name>` | a shared component |
| `tokenKey(name)` | `token:<name>` | a shared design token |
| `topicKey(name)` | `topic:<name>` | a shared topic |

Component, token and topic names are lower-cased with runs of spaces turned to `-`, so
`Date Picker` and `date picker` give one key. A blank name throws. `relationKind(key)` returns
the kind of a relation key, or null for a merge key or anything else. `prKey(repo, pr, headSha)`
builds a PR merge key in the canonical lower-case form.

## Round questions as items

The approval flow treats review-round questions as OwnerItems alongside every other ask.

```ts
import { answeredFromFeedback, buildOwnerRounds, fromRoundQuestions } from "@titan-design/owner-queue";

const { manifest, bindings } = buildOwnerRounds(open, options).rounds[0]!;
const context = { roundId: "decisions-r1", openedAt: "2026-01-01T00:00:00Z", bindings };

const asked = fromRoundQuestions(manifest, context.roundId, context);
const answered = answeredFromFeedback(feedbackJson, manifest, context);
// a single-item question comes back as that item, with the owner's pick as its option id
```

- **Ids and keys.** An item is `round:<roundId>/<questionId>` with source
  `{ system: "round", ref: "<roundId>#<questionId>" }` and the question's `ask:` key. With
  the bindings `buildOwnerRounds` returned, a question that asked one item takes that item's
  id and option ids, so a round built and then answered round-trips. A `Principle:` question
  settles several items, so it stays a round item with options `yes` and `no`.
- **Kinds.** A merge-bound pick-one is `approve` with lens `blocking-merge` and carries the
  `pr:` key pinned to its head. A bound question is `decide` and any other is `review`, both
  with lens `planning`.
- **Text.** The prompt becomes a one-line summary of at most 280 characters. The context is
  the question's section `deciding` and `context`, or the round's `context`. A pick question
  with two to eight options keeps them; any other is asked as free text. A pick-one
  recommendation on an offered option becomes `recommended`, hidden in an `after-answer` round.
- **Answers.** `answeredFromFeedback` returns only the questions the feedback answered and
  did not list in `unansweredQuestionIds`, with status `answered`, `at` its `submittedAt` and
  `by` `ROUND_ANSWERER`. An offered pick becomes `optionId` and offered pick-many picks become
  `optionIds`, both through the bindings; free text, a scale value, a pick the question does
  not offer and the comment become `text`. A feedback `revisionRequested` becomes
  `changeRequested: true`, kept even with no comment or when a partial submit lists the
  question unanswered, so a change request on a merge-bound question still blocks the ship.
  Non-empty `variantComments` are carried as they are.
- **Validation.** Both functions parse with `ManifestSchema` and `FeedbackSchema` from
  `@titan-design/review-schema` and throw on an invalid file, an invalid `openedAt`, or a
  feedback whose unit or round differs from the manifest. round@2 carries no time, so
  `openedAt` is the caller's.
- **Until question ids are stable.** `buildOwnerRounds` numbers questions `q1`, `q2`, … per
  round, so the default `ask:` key only matches within a unit and question id. Builders that
  keep an id per ask make it match across rounds.

## Re-checking against answers

An open question may already have its answer: the owner settled the same ask in a later
round, or answered a neighbour about the same component. `recheck(open, answered)` reads the
answered items (anything carrying an `answer`, such as `answeredFromFeedback` returns) and
says which open items are settled and which deserve a note.

```ts
import { recheck } from "@titan-design/owner-queue";

const { open, dropped, flags } = recheck(asked, answered);
// dropped[i] = { item: { ...item, status: "gone-elsewhere" }, cite: { answerId, key, at } }
// flags[i]   = { itemId, kind: "conflict" | "reasked" | "related-answer", answerId, keys }
```

| Shared key | Answer | Result |
|---|---|---|
| `ask:` | newer than the item's `openedAt`, not pinned to another head of the item's PR | dropped as `gone-elsewhere`, citing the newest such answer |
| `ask:` | older, or pinned to another head of the item's PR | `conflict` if it is not the recommended pick, else `reasked` |
| only `component:`, `token:` or `topic:` | any | `related-answer`; never drops |

- **Heads.** An answer given on one head of a PR never settles an item pinned to another
  head of it, so a new commit always gets its own look. It still shows as a flag. A PR key
  with no `@<sha>` pins nothing, so on either side it never blocks a settle. Heads compare as
  written, case-insensitively: a short sha is a different head from its full form.
- **Conflict.** Free text, a change request or a different pick against an item's
  recommendation is a conflict. An item with no recommendation reads as reasked.
- **Order.** `open` is sorted by id and `flags` by item, answer and kind, so the result is the
  same for any input order.

## Consolidating the queue

`consolidate(open, { answered, heads, stacks, deps })` runs the whole pass the approvals
page reads, recomputed on every read and every answer. It composes `supersede`, `recheck`,
`mergeByKeys`, `stackContext` and `rank`, then adds groups, influence order and holds.

```ts
import { consolidate } from "@titan-design/owner-queue";

const flow = consolidate(openItems, {
  answered,                                   // answered items, feedback answers included
  heads: { "org-a/repo-1#12": liveHeadSha },
  stacks: { "org-a/repo-1#13": "org-a/repo-1#12" },
  deps: { "T-2": ["T-1"] },                   // task id to the task ids it depends on
});
// flow.groups[i] = { id: "pr:org-a/repo-1#12", kind: "pr", itemIds, shipBlockedBy }
// flow.order, flow.held, flow.withdrawn, flow.dropped, flow.flags, flow.context, flow.edges
```

1. **Supersede.** Items on an old head of a PR are `withdrawn` as `new-head:<sha>`. The live
   head counts answered items too, so a newer answered round moves it.
2. **Re-check.** `recheck` against every answered item gives `dropped` and `flags`.
3. **Dedupe.** `mergeByKeys` runs within one class: the item kind, with round questions kept
   apart from every other source. A shared merge key across classes becomes an `overlap`
   edge instead, so answering a review round never resolves a gate.
4. **Context.** An item on a stacked PR lists its base PRs in `context[itemId]`.
5. **Group.** Groups are fixed per PR: an item naming exactly one PR joins `pr:<owner>/<repo>#<n>`.
   An item naming none or several, such as a cross-PR decision, joins a `topic` group, built
   by union-find over shared `task:`, `component:`, `token:` and `topic:` keys.
6. **Influence.** `edges` say A likely changes B:

   | Rule | When |
   |---|---|
   | `base` | A is on B's base PR |
   | `pr-decision` | they share a PR, A decides, B reviews or approves |
   | `shared-unit` | they share a component or token, A decides or is one-way, B reviews or approves |
   | `unblocks` | `A.unblocks` holds B's `task:` key, or B's task depends on A's in `deps` |
   | `topic` | they share a topic, A decides, B does not |
   | `overlap` | step 3 kept them apart; decisions, then reviews, then approvals; a round before a gate |

   Topic groups come first. Groups then sort by the most transitive dependents of any member,
   then by best `rank`. Inside a group the order is topological, with `rank` breaking ties
   and cycles.
7. **Hold.** `held[i] = { itemId, waitsOn }` lists the earlier items that likely change it.
   Only edges from earlier in the order hold, so a cycle never holds all of its members.

**Ship gate.** Each PR group carries `shipBlockedBy`, the open change requests on that PR at
its live head, on any tab: `change-requested`, `free-text` (text or variant comments), or
`other-choice` (a pick that is not the recommended, implemented one). An unanswered question
never blocks. A newer answer to the same `ask:` replaces an older one, and an answer on an
old head is withdrawn, so neither blocks. An empty list means Ship may go.

**Order.** The Flow is the same for any order of `open` and `answered`. Flags keep the id of
the item `recheck` saw, which may be a non-primary item that step 3 merged away.

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

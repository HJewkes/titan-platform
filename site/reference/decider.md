# decider

**Tier 2.** Depends on [`memory`](/reference/memory), `store-sqlite`, `session-read` and `locator`; `zod` is a peer dependency.

```sh
npm install @titan-design/decider zod
```

## The problem it solves

Owner answers to agent questions were indexed by active-work's `precedent extract` into
`precedents.jsonl` with a `pick_type`, but nothing said whether an answer accepted, amended or
redirected the asker's recommendation, and nothing kept human-only work out of the index. This
package adds the ledger row shape that a decider, a shadow scorer and a condensation run can share:
a v2 schema that still reads v1 rows, a pure outcome classifier, and a pure exclusion check. It
also holds the ledger itself: an append-only SQLite store keyed by row key, a `LedgerSource` port
with a watermark per source cursor, the `AskUserQuestion` transcript source and the decision-notes
source.

## When to reach for it

- You write or read owner-decision rows: parse them with `LedgerRowSchema`.
- You need the outcome of an answer against the asker's options and recommendation:
  `classifyOutcome`.
- You must decide, before writing a row, whether it belongs to a human-only initiative, names
  personal data, or has no resolvable initiative: `isExcluded`.
- You keep a ledger on disk: `openLedgerStore(path)` and `extractSource(store, source, policy)`.
  Re-running extraction writes nothing new, and excluded rows are dropped before the write.
- You add a new kind of owner answer: implement `LedgerSource` (`{ name, read(since) }`) and
  return candidates past `since` plus the watermarks you moved.
- You condense owner answers into principles: `principleBullet` makes a `memory` bullet whose
  category is the domain, `feedbackForRow` turns a row into helpful or harmful feedback keyed by
  `ledger:<key>`, and `applyFeedback` records it once per key.
- You need the per-domain principle docs a decider reads: `principlesByDomain`,
  `changesByDomain` and `writePrincipleDocs(dir, ...)`.
- You run condensation on a schedule: `condense({ playbook, watermarks: condenseWatermarks(db) },
  ledger.entries(), reflector, { docsDir })`. The reflector is your model call; its output is validated, and
  the watermark follows insertion order, so an old answer extracted late is still condensed.
- You need the questions no principle may answer: `ALWAYS_ASK` and `alwaysAskList(hardStops)`.
- You decide where a question goes before any model runs: `route(question, policy, ctx)` returns
  `owner-now`, `owner-queue` or `decider`, a shadow flag and the reason, first match wins.
- You judge whether a category may graduate: `score(predictions, ledger, { policy, now })` gives
  per-category agreement, whether to recommend `auto`, and whether 2 overrules in 7 days demote it.

For the decaying principles condensed from these rows, use [`memory`](./memory). For raw
transcript parsing, use [`session-read`](./session-read).

## Example

Verified against 0.1.0.

```ts
import { LedgerRowSchema, classifyOutcome, isExcluded } from "@titan-design/decider";

const options = ["Use a queue (Recommended)", "Use a cron job"];
classifyOutcome({ answer: "Use a queue, capped at three retries", options, recommended: "Use a queue (Recommended)" });
// "amend"

const verdict = isExcluded(
  { initiative: null, cwd: "/srv/scratch", header: "Scheduler", question: "Which?", options: [], answer: null },
  { humanOnlyInitiatives: ["garden-diary"], projectInitiatives: [], personalDataPatterns: [] },
);
// { excluded: false, initiative: null, unclaimed: true }

const row = LedgerRowSchema.parse({
  key: "note:widgets/scheduler.md",
  source: "note",
  asked_at: null,
  initiative: "widgets",
  class: "tech_design",
  header: null,
  question: "Scheduler choice",
  options: [],
  recommended: null,
  answer: null,
  pick_type: "none",
});
// row.v === 1, row.category === "tech_design", row.outcome === "none"
```

Extracting `AskUserQuestion` answers from every Claude Code transcript into a ledger file:

```ts
import { extractSource, openLedgerStore, transcriptSource } from "@titan-design/decider";

const store = openLedgerStore("/var/example/decider.sqlite3");
const summary = await extractSource(store, transcriptSource(), policy);
// { source: "transcript", read, written, alreadyIndexed, excluded: { ... }, pending, errors }
```

Extracting decision notes from an active-work root, where each initiative keeps notes under
`<slug>/sources/notes/`:

```ts
import { extractSource, noteSource } from "@titan-design/decider";

await extractSource(store, noteSource({ root: "/var/example/active-work" }), policy);
// rows keyed note:<slug>/<file>, outcome "none"
```

Principles live in a `memory` playbook. An owner answer that agrees with a principle is helpful
feedback, one that contradicts it is harmful, and the playbook's maturity pass does the rest.

```ts
import { PlaybookStore, applyMaturity, curate, memoryMigration } from "@titan-design/memory";
import {
  applyFeedback,
  changesByDomain,
  feedbackForRow,
  principleBullet,
  principlesByDomain,
  writePrincipleDocs,
} from "@titan-design/decider";

const store = new PlaybookStore(db); // db migrated with memoryMigration(1)
const { id } = store.add(principleBullet({ rule: "Prefer a queue over cron", domain: "tech_design", citedKeys: [row.key] }));

const { feedback } = feedbackForRow(laterRow, [{ principleId: id, verdict: "contradicts" }]);
const applied = applyFeedback(store, feedback);
const maturityChanges = applyMaturity(store, new Date());

writePrincipleDocs({
  dir: principlesDir, // the caller's private data directory, never a repo
  principles: principlesByDomain(store, new Date()),
  changes: changesByDomain(store, { maturityChanges, feedback: applied.recorded }),
  now: new Date(),
});
// principlesDir/tech_design.md: rule, examples, counter-examples, confidence, last confirmed, version, changelog
```

## What it deliberately does not do

- It never reads the charter or an owner overlay. Exclusion policy arrives as data.
- It does not choose where the ledger file lives; the caller passes the path.
- The decision-notes source is not ported yet, and the agent-chat and Morning sources come in
  TP-699 and TP-700.
- `classifyQuestion` is only a keyword seed for `category`; the decider corrects it when it cites.
- It does not judge whether an answer agrees with a principle. The reflector supplies the
  `Citation` verdicts; this package only maps them to feedback.
- It never picks a data directory. `writePrincipleDocs` writes where the caller says.

## Gotchas

- `isExcluded` returns a verdict object, not a boolean. A row that is not excluded can still be
  `unclaimed`; write it with `unclaimed: true` so condensation and recall skip it.
- A string personal-data pattern matches as a case-insensitive whole word. Pass a `RegExp` for
  anything else.
- `classifyOutcome` returns null for an unparsed answer and for a declined (`rejected`)
  question. Null means "out of scoring", not "none".
- `recommended` is stored with its marker stripped: a bracketed group containing "recommend", or
  "Recommended" set off by a colon or a spaced dash as prefix or suffix. Option labels keep theirs
  verbatim. A negated marker ("not recommended") is not a recommendation, and
  `isRecommendedLabel` is the one test both the transcript source and `stripRecommended` use.
- Personal-data patterns are checked against the header, question, answer, option labels and
  option descriptions.
- A transcript call with several questions writes one row per question. The first keeps v1's key
  `transcript:<session>:<tool_use_id>`; later ones add `#<n>`.
- An unanswered question holds its transcript's watermark at its own line, so the next run
  re-reads from there and writes it once the answer lands.
- The note source keeps v1's key `note:<slug>/<file>` and writes a `kind: decision` note, or a
  `memory-import` note tagged or trailed as `feedback`. Its watermark is a note's byte length and
  sha256, so only a changed note is parsed again; a malformed note is reported once per change.
- Store migrations are numbered from 3000 so the ledger can share a database file with other
  stores.
- `feedbackForRow` returns no feedback for rows answered by the decider, unclaimed rows and
  unparsed answers: only the owner's own answers are evidence. An overrule row adds harmful
  feedback on every principle in its `prediction`.
- A doc's version moves only when the run changed something in that domain; decaying scores
  alone rewrite the body without a new version.
- `ALWAYS_ASK` is frozen data. Hard stops arrive through `alwaysAskList(hardStops)` as
  `hard_stop:<text>` ids; the package never reads a charter.
- `route` never widens: an always-ask category, an unlock-table phrase in the header, question or
  any option, a hard-stop phrase or a human-only initiative keeps the question with the owner
  whatever the category's mode. `setCategoryMode` throws on raising a locked category, and
  `parseRoutingPolicy` forces a stored one back to `off`.
- Categories, initiatives and hard stops compare after folding case, spaces, `-`, `_` and
  punctuation, so `Merge-Gate` is `merge_gate`. A category outside agent-chat's decidable set
  never routes to `decider`, even in `auto`.
- The unlock table is broad on purpose ("release the claim" matches); `unlock.test.ts`
  pins it to agent-chat's verdicts, so change both together.

## Where it came from

The row shape is a superset of active-work's `PrecedentRow` (`src/precedent/schema.ts`), and the
outcome mapping follows its `pick_type`. The transcript source, answer parser and category
seed are ported from its `transcripts.ts`, `parse-answer.ts` and `classify.ts`, and the note
source from its `notes.ts`. Planned in TP-695 as slices TP-696, TP-697, TP-701 and TP-730; TP-698 swaps active-work onto this package and deletes its copy.

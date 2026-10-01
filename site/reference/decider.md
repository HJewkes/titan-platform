# decider

**Tier 2.** Depends on [`memory`](/reference/memory); `zod` is a peer dependency.

```sh
npm install @titan-design/decider zod
```

## The problem it solves

Owner answers to agent questions were indexed by active-work's `precedent extract` into
`precedents.jsonl` with a `pick_type`, but nothing said whether an answer accepted, amended or
redirected the asker's recommendation, and nothing kept human-only work out of the index. This
package adds the ledger row shape that a decider, a shadow scorer and a condensation run can share:
a v2 schema that still reads v1 rows, a pure outcome classifier, and a pure exclusion check.

## When to reach for it

- You write or read owner-decision rows: parse them with `LedgerRowSchema`.
- You need the outcome of an answer against the asker's options and recommendation:
  `classifyOutcome`.
- You must decide, before writing a row, whether it belongs to a human-only initiative, names
  personal data, or has no resolvable initiative: `isExcluded`.
- You condense owner answers into principles: `principleBullet` makes a `memory` bullet whose
  category is the domain, `feedbackForRow` turns a row into helpful or harmful feedback keyed by
  `ledger:<key>`, and `applyFeedback` records it once per key.
- You need the per-domain principle docs a decider reads: `principlesByDomain`,
  `changesByDomain` and `writePrincipleDocs(dir, ...)`.
- You need the questions no principle may answer: `ALWAYS_ASK` and `alwaysAskList(hardStops)`.

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

- It never reads the charter, an owner overlay or any file. Exclusion policy arrives as data.
- No store, sources or watermarks yet; those land in TP-697.
- It does not classify a question's category; rows carry the precedent-search class vocabulary.
- It does not judge whether an answer agrees with a principle. The reflector supplies the
  `Citation` verdicts; this package only maps them to feedback.
- It never picks a data directory. `writePrincipleDocs` writes where the caller says.

## Gotchas

- `isExcluded` returns a verdict object, not a boolean. A row that is not excluded can still be
  `unclaimed`; write it with `unclaimed: true` so condensation and recall skip it.
- A string personal-data pattern matches as a case-insensitive whole word. Pass a `RegExp` for
  anything else.
- `classifyOutcome` returns null for an unparsed answer. Null means "out of scoring", not "none".
- `recommended` is stored without its "(Recommended)" suffix; option labels keep theirs verbatim.
- `feedbackForRow` returns no feedback for rows answered by the decider, unclaimed rows and
  unparsed answers: only the owner's own answers are evidence. An overrule row adds harmful
  feedback on every principle in its `prediction`.
- A doc's version moves only when the run changed something in that domain; decaying scores
  alone rewrite the body without a new version.
- `ALWAYS_ASK` is frozen data. Hard stops arrive through `alwaysAskList(hardStops)` as
  `hard_stop:<text>` ids; the package never reads a charter.

## Where it came from

The row shape is a superset of active-work's `PrecedentRow` (`src/precedent/schema.ts`), and the
outcome mapping follows its `pick_type`. Planned in TP-695 as slice TP-696; TP-698 swaps
active-work onto this package and deletes its copy.

# decider

**Tier 2.** No titan dependencies yet; `zod` is a peer dependency.

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

## What it deliberately does not do

- It never reads the charter, an owner overlay or any file. Exclusion policy arrives as data.
- No store, sources or watermarks yet; those land in TP-697.
- It does not classify a question's category; rows carry the precedent-search class vocabulary.

## Gotchas

- `isExcluded` returns a verdict object, not a boolean. A row that is not excluded can still be
  `unclaimed`; write it with `unclaimed: true` so condensation and recall skip it.
- A string personal-data pattern matches as a case-insensitive whole word. Pass a `RegExp` for
  anything else.
- `classifyOutcome` returns null for an unparsed answer. Null means "out of scoring", not "none".
- `recommended` is stored without its "(Recommended)" suffix; option labels keep theirs verbatim.

## Where it came from

The row shape is a superset of active-work's `PrecedentRow` (`src/precedent/schema.ts`), and the
outcome mapping follows its `pick_type`. Planned in TP-695 as slice TP-696; TP-698 swaps
active-work onto this package and deletes its copy.

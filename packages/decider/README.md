# @titan-design/decider

The owner-decision ledger: the `LedgerRow` v2 schema, the outcome classifier, the
exclusion check that runs before a row is written, the store, and the transcript and note sources.

Tier 2 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

- `LedgerRowSchema` parses v2 rows and active-work's v1 `PrecedentRow`. A v1 row keeps
  `v: 1`, its `class` becomes `category`, and its `pick_type` yields `outcome`.
- `classifyOutcome` returns `accept`, `amend`, `other`, `redirect`, `none`, or null for an
  unparsed answer that stays out of scoring.
- `isExcluded(subject, policy)` takes the human-only initiatives, the project-directory
  mapping and the personal-data patterns as data. It never reads a charter or a file.
- Principles are `@titan-design/memory` bullets (category = domain, provenance = `ledger:<key>`).
  `feedbackForRow` maps a row and the reflector's verdicts to helpful or harmful feedback;
  `applyFeedback` records it once per ledger key.
- `writePrincipleDocs` renders one `<domain>.md` per domain into a directory the caller passes:
  rule, cited examples, counter-examples, confidence, last confirmed, version and changelog.
- `condense(store, rows, reflector)` is the condensation run. Per domain it feeds the rows
  inserted since its watermark (`LedgerStore.entries()`, in insertion order) to an injected
  `Reflector`, validates its deltas with zod, records feedback, curates proposals as candidates
  and runs the maturity pass. Decider answers are never evidence, and a row whose question
  carries an instruction can neither ground nor confirm a principle.
- `ALWAYS_ASK` is the fixed always-ask list; `alwaysAskList(hardStops)` adds the charter's.
- `route(question, policy, ctx)` is the pure routing table: `owner-now`, `owner-queue` or `decider`,
  with a shadow flag and a reason. `parseRoutingPolicy` holds one mode row per category and keeps
  always-ask categories `off`. `checkUnlock` is agent-chat's unlock table, parity-tested.
- `score(predictions, ledger, { policy, now })` is the shadow scorer: per-category agreement, missed
  redirects and the accept baseline over each policy window, a `recommendAuto` graduation verdict and
  a `demote` flag on 2 overrules in 7 days; those 2 overrules also withhold `recommendAuto`, so a
  score never recommends auto for a category it demotes. `applyDemotions` drops demoted categories back to shadow.
- `LedgerStore` (`openLedgerStore(path)`) is append-only by row key, with a watermark per source
  cursor on `@titan-design/store-sqlite`.
- `LedgerSource` is the port `{ name, read(since) }`; `extractSource` runs one source, drops
  excluded rows before anything is written, appends the rest and advances the watermark.
- `transcriptSource()` reads `AskUserQuestion` calls from Claude Code transcripts through
  `@titan-design/session-read`, ported from active-work's `src/precedent/transcripts.ts`.
- `noteSource({ root })` reads decision notes and feedback memory imports under
  `<root>/<initiative>/sources/notes/`, ported from active-work's `src/precedent/notes.ts`.

## `ask-lint`

The `ask-lint` bin prints the AskUserQuestion contract findings (`ASK_RULES`, AQ1 to AQ5) for a
Morning list or queue file, or with `--section` for one section of a plan, as
`<item id> <rule> <evidence>` lines.

```sh
ask-lint morning/2026-10-05.md                       # lintMorningList on the whole file
ask-lint plan.md --section "Owner questions"         # lintOwnerQuestions on that section only
ask-lint queue.md --json --strict                    # one JSON object per finding; exit 1 on any
```

Exit 0 by default, 1 under `--strict` when any finding exists, and 2 with one stderr line on a
missing file or `--section` heading.

Status: slices 1, 2, 2b and 6 of TP-695 (TP-696, TP-697, TP-730, TP-701).

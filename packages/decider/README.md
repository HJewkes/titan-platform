# @titan-design/decider

The owner-decision ledger: the `LedgerRow` v2 schema, the outcome classifier, the
exclusion check that runs before a row is written, the store and the transcript source.

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
- `ALWAYS_ASK` is the fixed always-ask list; `alwaysAskList(hardStops)` adds the charter's.
- `LedgerStore` (`openLedgerStore(path)`) is append-only by row key, with a watermark per source
  cursor on `@titan-design/store-sqlite`.
- `LedgerSource` is the port `{ name, read(since) }`; `extractSource` runs one source, drops
  excluded rows before anything is written, appends the rest and advances the watermark.
- `transcriptSource()` reads `AskUserQuestion` calls from Claude Code transcripts through
  `@titan-design/session-read`, ported from active-work's `src/precedent/transcripts.ts`.

Status: slices 1, 2 and 6 of TP-695 (TP-696, TP-697, TP-701).

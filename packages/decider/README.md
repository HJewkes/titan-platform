# @titan-design/decider

The owner-decision ledger: the `LedgerRow` v2 schema, the outcome classifier and the
exclusion check that runs before a row is written.

Tier 2 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

- `LedgerRowSchema` parses v2 rows and active-work's v1 `PrecedentRow`. A v1 row keeps
  `v: 1`, its `class` becomes `category`, and its `pick_type` yields `outcome`.
- `classifyOutcome` returns `accept`, `amend`, `other`, `redirect`, `none`, or null for an
  unparsed answer that stays out of scoring.
- `isExcluded(subject, policy)` takes the human-only initiatives, the project-directory
  mapping and the personal-data patterns as data. It never reads a charter or a file.

Status: slice 1 of TP-695 (TP-696). The store and sources land in TP-697.

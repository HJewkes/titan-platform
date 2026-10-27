---
"@titan-design/active-work": minor
---

Add the platform open-loops ledger verbs (TP-4316 A1). `loop board [--json]` (rpc `loop.board`) returns
the ledger rows, the open session loops no ledger row claims, and the tech tree. `loop import` upserts a
sweep snapshot and keeps any tier already set; `--tiers` seeds the untiered loops as a proposal.
`loop tier <id> <tier> [--before <id>]` re-tiers one loop and leaves every other row byte-identical.
`loops <slug>` rows now carry `source` and include the ledger's open rows for that initiative. The
ledger location is the `loops.ledger` key in config.json, defaulting to
`titan-platform/sources/open-loops.yml` and `sources/tech-tree.yml`.

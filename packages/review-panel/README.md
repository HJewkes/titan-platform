# @titan-design/review-panel

Review-panel types and the reviewer ports a caller satisfies

Tier 2 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Status: types, ports, `classifyPr`, `planPanel`, the reviewer briefs and the verdict acceptor. Tracked by TP-1916.

`acceptVerdict(input, messages)` decides whether a reviewer's final message is its verdict for this PR at this head: the dispatched agent and session, written after dispatch, a block that names the target, and at least one investigative call (`isInvestigativeCall`) unless the reader could not count. Anything else is `{ kind: "none" }`, with a `malformed` record (`readMalformed`) when the block was refused or named another target. A FIX_FIRST carries its findings, bounded by `boundedFindings`; a verdict carries the reviewer's OWNER-BRIEF block as `parseOwnerBrief` reads it.

`classifyPr(facts, rules?)` returns the review class (`g10` or `standard`) and the touch flags, from signals alone. `DEFAULT_CLASS_RULES` holds the glob tables and the large threshold (400 lines; more than 12 files when a file lacks line counts); pass `rules` to override them.

`planPanel(cls, policy, headroom)` plans the panel for one head: each member's shape, profile, brief id and blocking flag, and a spend estimate in points. It plans at most 3 members and 1 opus member, and drops none on cost. When `headroom.opus` is false, an opus member is planned at its sonnet profile with `degraded: true`. `DEFAULT_PANEL_POLICY` has no panel table, so it plans the correctness member alone at the `g10` or `standard` profile (`bd-reviewer`, `reviewer`); set `panel: DEFAULT_PANEL_TABLE` for the class table.

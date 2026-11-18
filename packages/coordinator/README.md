# @titan-design/coordinator

Tier 2 of the titan-platform DAG. Depends on `@titan-design/agent-dispatch` (tier 1) for
`limitsSchema`. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Exports `seatConfigSchema` (zod) and its inferred types for `autonomy-seat/v1` seat front
matter, `charterPolicySchema` and `parseCharterPolicy` for `autonomy-charter/v1` charter
front matter, and `foldSeatEvents`, a pure fold from a seat's event log (`seatEventSchema`) to
`SeatState`. `coordinatorConfigSchema` and `checkCoordinatorConfig` validate a whole
`titan-coordinator/v1` document and its cross-references. `authoredBlockSchema`, `parseAuthored` and
`renderAuthored` validate and render the seat's authored handoff block. `applyEdit`, `diffDocuments` and
`verifyChain` edit, diff and check a revision log of that document (`configRevisionSchema`). `EDITABLE_FIELDS` with
`checkEditableValue` is the allowlist of config fields an editor may change. Pure code: no fs, process, network or broker. See `site/reference/coordinator.md`.

The first npm publish is pending and owner-only; trusted publishing is set up after it.

## Risk contracts

A plan that owns security, authority, policy or migration paths states its risk in a fenced `risk-contract`
JSON block: `id`, optional `programme`, `kind`, `rule`, `delta`, `paths`, `requires`, `release` and
`ownerApproval: { decision, ruleSha256 }`. `readRiskContract(planText)` returns `{ contract }` or
`{ problems }`, the same shape as the burndown slice reader. `ruleDigest(rule)` is the sha256 of the rule
after NFC normalisation and whitespace collapsing. `approvalState(contract, decisionsText)` is `approved`
only when the approval's decision id is a heading or numbered item in the decisions text (`341(2)` is item 2
under heading 341) and `ruleSha256` still equals `ruleDigest(rule)`, so editing the sentence after approval
un-approves it. `resolveProgramme(contract, read)` follows a `programme` reference through a reader the host
passes in and refuses a missing file, a chained programme, or a restated field that differs.

---
"@titan-design/factory": minor
---

Add `titan-factory shepherd plan-round <plan>` (TP-4360 slice 2). It reads one PR's planned file list from a plan's `plan-round` fence, a JSON file or stdin, predicts each WHAT gate with the merge guard's own predicates (`isGithubPath` with the plan's `ciPolicyKeys`, `skillPathsIn`, and `visualMatches` over the owning seat's `visual_paths`), pins every file of a ci-policy plan to its git blob sha, and prints a questions-only round.json with a `planApprovals` block for `titan-console decisions file -`. The owner sees each pinned file's changed lines against the base. It only drafts: it writes nothing to serve, the store or the console. `PlanApprovalActionSchema` is now exported so each printed binding is checked against the record the factory will parse.

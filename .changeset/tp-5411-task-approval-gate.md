---
"@titan-design/owner-queue": minor
"@titan-design/factory": patch
---

Gate model S8a (TP-5411): a `task` gate kind for plan rounds. owner-queue's `buildPlanRound` takes a `task` ask (`TaskPlanScope`: done_when hash, owner-rule reason, visual sign-off flag) and renders it as one "Validate <ID>: <title>?" question with approve and not-now options. The factory records the owner's console approve pick as a `task` row in `shepherd_plan_approval`, keyed by the canonical `<initiative>/<ID>`, never claimed by a run, and read only through `ownerTaskApproval`. `titan-factory shepherd plan-round --task-approval <initiative>/<ID> --reason <reason> --repo <owner/name> [--visual-signoff]` drafts the round for a task tagged `owner-validate`.

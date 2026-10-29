---
"@titan-design/factory": minor
---

Record the owner's plan-time approvals (TP-4284 slice 1). A new `shepherd_plan_approval` table holds them, written only by a `plan-approval` console action record, as the console's owner-remote; no CLI, MCP or port path writes it. The scope is a union on `gate`: `ci-policy` pins CI-policy keys and the git blob of each changed file at head, `skill` and `visual` name exact paths. Each approval is claimed by exactly one run, at registration or, when exactly one live registration of the task exists, at the console write; `forRun(runId, task, repo)` reads only the console-written approvals that run claimed for its current task. No merge guard row honours an approval yet.

---
"@titan-design/active-work": minor
---

Add `active-work plan` verbs over one validated file per record under `<initiative>/plan/`: `outcome`, `bet`, `freeze` and `out-of-scope`, each with `add`, `show` and `list`, also served over RPC and MCP. `plan bet add` writes a proposed bet; `plan outcome add` writes a draft once and refuses an existing outcome. No verb selects a bet or edits an outcome: those are owner actions. Lists across initiatives skip owner-only ones. `task add` and `task edit` take `--bet`, `--fold` and `--owner-step`, and a task's bet is now checked against the plan store (TP-5453 P3a).

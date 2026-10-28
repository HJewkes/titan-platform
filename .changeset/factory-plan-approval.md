---
"@titan-design/factory": minor
---

Honour the owner's plan-time approvals at Shepherd's merge guard (TP-4284). A new `shepherd_plan_approval` table holds them, written only by a `plan-approval` console action record, as the console's owner-remote; no CLI, MCP or port path writes it, and the guard ignores a row any other actor wrote. Each `sh-policy` read attaches the registration task's approvals as `EffectivePolicy.approved`, which run params and stored policies cannot carry. The skill-path, visual-path (glob) and ci-policy-weakened rows then allow when one approval of that gate holds every fact the row triggered on at the head: exact paths, CI-policy keys and each changed `.github/` line of the card's positional diff, matched by its own `{path, side, n, text}` entry, indentation included (only a JSON line that gained a trailing comma ahead of an added line is no change). The allow reason names the plan round.

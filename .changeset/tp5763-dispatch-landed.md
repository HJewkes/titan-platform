---
"@titan-design/factory": minor
---

Add the landed rules to the shadow dispatcher (TP-5763, TP-5755 S5). A lane task whose PR merged but whose task is still open with a `restart`, `config`, `release`, `publish` or `credential` owner step now counts as `merged-not-switched-on` against the lane's open-PR limit, beside the open and merged-not-deployed counts; a `sitting`-only step does not, and a done task frees its slot. When the lane's filing flow is paused, an agent-filed task created in a paused week is refused as `filing-paused`; an owner-filed task never is. Rows carry `numbers: {open, mergedNotDeployed, mergedNotSwitchedOn, limit}`. `dispatch eligible` output is unchanged.

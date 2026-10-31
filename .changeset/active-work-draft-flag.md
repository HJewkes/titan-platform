---
"@titan-design/active-work": minor
---

`task add --draft` files a task without a `done_when`, skipping the agent-caller gate. A draft is an open task tagged `draft`, not a new status, so readers that parse status as `open|done` (the standalone 0.22 CLI, the console) keep working. The bootstrap leaves drafts out of its open list; `task edit --remove-tag draft` promotes one. The gate's refusal names `--draft`.

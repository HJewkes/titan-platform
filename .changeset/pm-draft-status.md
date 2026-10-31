---
"@titan-design/pm": minor
"@titan-design/active-work": minor
---

Add `draft` to the built-in statuses (open-like but not dispatchable). `task add --draft` files a task as a draft without a `done_when`, skipping the agent-caller gate; `task edit --status open` promotes it. A root whose category registry has no `draft` row refuses `--draft`, naming the allowed statuses.

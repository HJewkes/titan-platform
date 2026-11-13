---
"@titan-design/active-work": minor
---

`task add` and `task edit` take the task provenance fields: `--class`, `--serves` (checked against the plan's outcomes), `--source` with `--source-ref` or `--from-pr` and `--from-task`, and `--blocked-on`; each value given is marked `filed` in `field_origin`. `task add` records `filed_by` from `AGENT_CHAT_NAME` (or `owner` from a plain terminal), never from an argument, and refuses a task that leaves out a field the brief's `task_require` lists. Once a task has started or a spawn names it, `task edit` refuses changes to class, source and serves. `task done --reason` records `done_reason`. New read verb `task rank show <slug>` lists ranked tasks; no verb sets a rank (TP-5446 S8).

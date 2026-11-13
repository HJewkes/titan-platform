---
"@titan-design/pm": minor
"@titan-design/active-work": minor
"@titan-design/factory": patch
---

One canonical task key, `<initiative>/<TASK-ID>` (TP-5453 P5). `pm` exports `resolveTaskKey`, which turns a bare id, a prefixed key or a repo-qualified key into the canonical key, or refuses it as malformed, not found, ambiguous or wrong-initiative; an id two initiatives hold goes to the one whose `task_prefix` issued it. active-work's `list` items carry each initiative's `task_prefix` and `agent_visible`. `titan-factory shepherd register` stores the canonical key and exits 65 on a key that resolves to no one task (69 when the task index cannot be read); build-surface resolves its spec's tasks before any agent is spawned under them. `titan-factory shepherd task-key-report` lists the registrations whose key is not canonical, with a proposed mapping or no match, through a read-only store connection.

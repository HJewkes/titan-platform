---
"@titan-design/pm": minor
"@titan-design/active-work": minor
"@titan-design/factory": patch
---

One canonical task key, `<initiative>/<TASK-ID>` (TP-5453 P5). `pm` exports `resolveTaskKey`, which turns a bare id, a prefixed key or a repo-qualified key into the canonical key, or refuses it as malformed, not found, ambiguous or wrong-initiative; an id two initiatives hold goes to the one whose `task_prefix` issued it. active-work's new `task.keys` command lists each initiative's `task_prefix`, `agent_visible` and the ids of its task files, open and archived, read from file names (MCP tool `active__task__keys`). `titan-factory shepherd register` stores the canonical key and exits 65 on a key that resolves to no one task. On an active-work daemon older than `task.keys` it resolves through `task.list` plus the archive file names; when no complete index can be read it refuses only a malformed key, stores the rest as given with a warning, and marks the run `taskVerified=false` in its params; build-surface resolves its spec's tasks before any agent is spawned under them. `titan-factory shepherd task-key-report` lists the registrations whose key is not canonical, with a proposed mapping or no match, through a read-only store connection.

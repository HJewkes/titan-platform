---
"@titan-design/pm": minor
---

Add the deliverable registry: `DeliverableSchema` (`id`, `title`, `done_when`, `target`, `status` of `planned`, `active`, `shipped` or `dropped`, `owner_seat`, retrieval-only `tags`, `created`, `updated` and `shipped_at`, which is set exactly when the status is `shipped`), `DELIVERABLE_ID_REGEX`, `DELIVERABLE_STATUSES`, `deliverablesDir(activeRoot)` for `<activeRoot>/titan-platform/deliverables`, `deliverablePath(activeRoot, id)`, and `parseDeliverableRegistry(entries)`, which validates the files the host read and treats no entries, a missing directory, as an empty registry. `TaskSchema` gains an optional `deliverables` list of unique deliverable ids.

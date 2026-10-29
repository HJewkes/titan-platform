---
"titan-console": minor
---

Keep active-work reads in a keyed stale-while-revalidate cache. Concurrent identical `list`, `task.list`, `inventory`, `note.list`, `source.list`, `artifact.list`, `source.read`, `context.graph` and `deliverable.list` reads share one upstream call, an answer under five seconds old is served as is, and one under two minutes old is served while a single refresh runs behind it. An active-work relay frame drops every kept read, and a factory frame drops the factory's. `approvals.flow` now reads the factory through the inbox's cached needs.list, so a slow needs.list no longer times it out.

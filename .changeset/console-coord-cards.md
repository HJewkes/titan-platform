---
"titan-console": minor
---

Add the `coord.cards` read: one card per spawning coordinator for a coordinator day, with agents run, agents live now, exit-reported cost, PRs merged through Shepherd and task ids with titles. Spawns come from agent-chat's events.db, since the broker's history window holds about an hour. A merged PR no spawn accounts for, or that two coordinators could own, is listed as unattributed. `coord.shipped` now takes the same calendar-checked `date` argument as the other coordinator reads.

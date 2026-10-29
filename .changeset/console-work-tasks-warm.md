---
"titan-console": minor
---

`work.tasks` answers warm in tens of milliseconds and sends about 127 KB instead of 1.6 MB. An active-work change frame now
marks the cached active-work answers stale instead of dropping them. They are still served while one refresh runs, and
the console sends the browser a `refreshed` frame once that refresh lands. Stage evidence and each path's git root are
served the same way, so a warm read spawns no git. Each row carries only what the board renders, and filters run on the
server. Each stage sends at most 200 rows (`perStage`) with a count of every match. The home page asks for blocked tasks
only.

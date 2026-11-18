---
"@titan-design/session-graph": minor
"@titan-design/active-work": minor
---

Add `sessionsTouchingFiles` to session-graph (TP-5453 P11b-1). It lists the sessions with a live `touched`
edge to any of the given repo-relative files since a time, newest first and capped. Each row has the
session's cwd, title, the matching file refs and the initiatives its task edges name. `context.brief` in
active-work uses it to add a recent-sessions section for the files an assignment names. The section covers
the last 14 days, holds at most 4 lines and stays within 500 bytes. It lists a session only when the agent
view shows its initiative, so sessions in owner-only initiatives, or in no initiative, never appear.

---
"@titan-design/factory": patch
---

Retry a Shepherd review whose reviewer went silent while the machine stop held. A dispatched reviewer that times out now runs `sh-review-stop`, which asks the wired machine-stop watch whether a stop applied during the round or applies now, and waits for it to lift. A lifted stop records the round as `throttled`: the same head is reviewed again by a fresh reviewer and the round is not counted. Only the first throttled round at a run is exempt (`MAX_THROTTLED_ROUNDS`); later ones count as failed rounds, so a machine that never settles still reaches approve-merge. With no watch wired, or on a healthy machine, a silent reviewer is a timeout as before.

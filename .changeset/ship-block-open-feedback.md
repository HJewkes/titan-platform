---
"titan-console": minor
---

A Ship round no longer ships while feedback is open. `rounds.get` returns an open Ship round's earlier feedback on the same unit as `priorFeedback`: each earlier round with a non-Ship pick, a revision request, a comment or a round note. The page shows each one above the Ship answer with an "Addressed" checkbox. Ship is disabled, with the reason written beside it, until every item is ticked and while the draft carries a change request: a comment, round feedback, or a side pick that differs from the implemented choice. Send back stays available. `rounds.submit` refuses a Ship pick for the same reasons. It takes the ticks as `addressed` and keeps them in an `addressed.json` file beside `feedback.json`.

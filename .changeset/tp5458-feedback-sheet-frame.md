---
"titan-console": minor
---

Render a round of `kind: "feedback"` on `#/rounds` as a read-only what-changed sheet (TP-5458, gate model S6). Each merged PR shows its link, head sha, task, changed visual paths and context, with one optional notes box. The sheet has no Ship control, check screen or pending status, and sending it with every box blank answers it. An open feedback sheet adds no inbox item and no six-hour nudge. The rounds list labels it `feedback`.

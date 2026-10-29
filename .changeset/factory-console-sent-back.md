---
"@titan-design/factory": minor
---

Let a console tap resolve an sh-sent-back gate with `await-new-head` (TP-3939 S8). `CONSOLE_STEPS` is now a map from step to the decisions a tap may give: `merge` on approve-merge, `await-new-head` on sh-sent-back. The route intersects that list with the decision enum in the gate's own schema, and refuses any other decision with 403 `class`, so an approve-merge record asking `abandon` or `send-back` now answers 403 `class` rather than 422 `record`. A sent-back gate's PR and head come from its evidence link and prompt; its answer is the decision alone.

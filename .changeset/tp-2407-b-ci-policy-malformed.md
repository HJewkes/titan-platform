---
"@titan-design/session-read": minor
---

`parseVerdictBlock` returns `ciPolicy: { kind: "malformed" }` for a visible line that folds to a CI-policy label (list and quote markers, markdown emphasis, case, and any Unicode dash, space or format character removed) that is not the one exact line directly after `Head:`; only a message with no such line leaves `ciPolicy` undefined (TP-2407 b).

---
"@titan-design/session-read": minor
---

`parseVerdictBlock` returns `ciPolicy: { kind: "malformed" }` for a visible line labelled CI-policy (case, spacing and separator folded) that is not the one exact line directly after `Head:`; only a message with no such line leaves `ciPolicy` undefined (TP-2407 b).

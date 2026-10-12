---
"@titan-design/session-read": minor
---

`parseVerdictBlock` reads the `CI-policy:` label on every raw line, fenced, indented or commented out, once each line is NFKC-folded, lower-cased and stripped of every non-alphanumeric character and any leading list number (TP-2407 b). A labelled `weakened` line with known keys reads weakened wherever it sits, `unchanged` counts only as the one exact visible line directly after `Head:`, and any other labelled line reads `{ kind: "malformed" }`. Across lines the strictest reading wins: weakened (keys merged) over malformed over unchanged. Only a message with no labelled line leaves `ciPolicy` undefined.

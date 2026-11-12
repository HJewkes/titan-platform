---
"@titan-design/session-read": minor
---

New `labelledLineRest(raw, label, strictValue?)` exports the fold the CI-policy line is read with (NFKC, lower case, any decoration around or inside the label), so every reviewer-verdict label can be detected the same way. The CI-policy reader now calls it; its behaviour is unchanged.

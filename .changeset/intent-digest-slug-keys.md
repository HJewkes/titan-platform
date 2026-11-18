---
"@titan-design/pm": patch
---

`parseIntentDigest` now refuses a slug that is not a lowercase slug and a slug that differs from `initiative` (TP-5783), and returns a line-numbered error for a repeated front matter key or an unknown one (TP-5784).

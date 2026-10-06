---
"@titan-design/fix-proof": minor
---

`classifyReports` now gives `error` instead of `reproduced` when any selected file is missing from the head report or fails to load there, matching the documented rule that ambiguous input never classifies as `reproduced`.

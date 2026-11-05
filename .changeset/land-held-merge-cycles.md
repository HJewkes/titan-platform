---
"@titan-design/factory": patch
---

Land no longer counts a merge step that waited on a hold toward its 20-cycle settle limit, so a PR held for an owner release stays parked instead of failing after about 20 hold checks, a restart included (TP-4082).

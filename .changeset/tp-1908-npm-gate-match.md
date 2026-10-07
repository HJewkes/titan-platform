---
"@titan-design/factory": patch
---

Treat an approve-merge gate as npm-blocked only when its prompt names the shepherd-release preflight-blocked policy row, so a conflict gate at the same head stays pending for the owner.

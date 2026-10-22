---
"@titan-design/factory": patch
---

`service deploy` no longer skips an asked sha whose own range reaches no factory path while origin/main already holds factory commits past it: it judges the running build..origin/main and deploys main instead (TP-3890).

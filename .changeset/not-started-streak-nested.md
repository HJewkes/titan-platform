---
"@titan-design/factory": patch
---

Read the not-started review flag from `data.result`, where the sh-review step stores it, so the "review dispatches started no reviewer" stall fires on real runs. Rows with the flag at the top level still count.

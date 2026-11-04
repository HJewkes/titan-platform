---
"@titan-design/worktree": patch
---

Install the park default-proof test's git shim through a staged copy so a concurrent fork cannot hold it open for writing (ETXTBSY), which park read as a detached HEAD.

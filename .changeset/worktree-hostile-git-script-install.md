---
"@titan-design/worktree": patch
---

Install the hostile-npmrc git script in the setup repo test through a staged copy so a concurrent fork cannot hold it open for writing (ETXTBSY).

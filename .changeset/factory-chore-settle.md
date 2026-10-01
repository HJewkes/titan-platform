---
"@titan-design/factory": patch
---

The post-merge chore settles on its process exit plus a short pipe grace instead of waiting for every holder of its output to close, so a chore that leaves a daemon behind records its real exit code without timing out. The timeout's group kill no longer targets a pid after its exit was observed.

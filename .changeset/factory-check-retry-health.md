---
"@titan-design/factory": patch
---

`service check` polls /health twice more, about 3 s apart, before it reports a live job pid as a stale pid, and the message names how many probes failed.

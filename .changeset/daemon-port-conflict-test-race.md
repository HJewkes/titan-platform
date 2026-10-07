---
"@titan-design/daemon": patch
---

Fix a flaky port-conflict test: the first daemon now binds an ephemeral port instead of a probed one that a parallel test could take before the bind.

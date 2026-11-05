---
"@titan-design/factory": patch
---

A Shepherd run waiting at its head on a freeze or a deploy no longer orders its merge-order peers, and a run waiting on attest-deploy-skew no longer counts as busy for the deploy pacer or the restart drain, so the deploy it waits for is not held by it (TP-4778).

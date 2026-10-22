---
"@titan-design/factory": patch
---

The A17 harness feeds now go through production entry points: the webhook feed posts signed deliveries to the ingress's `answerDelivery` with a test HMAC secret, and both modes run `startReconcilerSweep` (the 15 s due-check schedule and the reconciler's `observe`) over the github-api pool with a fake clock. Test support only; no production code changes.

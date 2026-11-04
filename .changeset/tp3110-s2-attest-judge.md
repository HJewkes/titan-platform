---
"@titan-design/factory": patch
---

Add `judgeAttestations`, which meets a no-semantic-change attestation only with an independent reviewer's `Attests:` line at the exact head, and the adversary's too where the class has one. The run's independence check moves to `lineage.ts` as `independentOfRun`, unchanged.

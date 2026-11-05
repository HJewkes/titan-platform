---
"@titan-design/factory": patch
---

Shepherd's run policy now carries a seat's `visual_baselines`, so a visual head that changes no baseline merges on its green baseline check instead of always gating on the owner (TP-2662). A repeat registration keeps baselines only when both policies carry the same ones. A vitest type test (`.test-d.ts`) under a visual glob no longer counts as rendering.

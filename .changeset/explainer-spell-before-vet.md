---
"@titan-design/explainer": patch
---

Spell spoken numbers before the rewrite pass vets them. The input script is spelled once before round 1 and each candidate beat is spelled before the guard, so the sentence cap, the speech-vet and L0 judge the final words. Before, a beat could pass the guard and then fail Q-V9 once its numbers were spelled at the end. The final spelling stays as a safety net.

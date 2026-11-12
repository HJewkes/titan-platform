---
"@titan-design/factory": patch
---

The recipe lint now rejects value imports of every `*-adapter.js` module, not only the redeploy and post-merge adapters; type imports stay legal. `factoryShepherdPhases` moved from `workflows.ts` to `shepherd-phases.ts` to keep `workflows.ts` under its line cap. No step id, order or recorded input or output changes.

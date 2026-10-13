---
"@titan-design/explainer": minor
---

Add the K2 history miner (`collect/history.ts`): `mineHistory` reads a local clone with git only and returns `history[]` and `decisions[]` whose why is quoted verbatim from a commit; `validateDecisions` rejects a decision whose sha is not a commit in the clone or whose why is not a quote (TP-2808).

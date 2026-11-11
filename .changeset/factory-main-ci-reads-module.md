---
"@titan-design/factory": patch
---

`MainCiReads` moves out of `shepherd/main-watch.ts` into its own `shepherd/main-ci-reads.ts`, with its tests; post-merge imports it from there. Behaviour is unchanged.

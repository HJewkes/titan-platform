---
"@titan-design/explainer": minor
---

Add the K2 history miner (`collect/history.ts`): `mineHistory` reads a local clone with git only and returns `history[]` and `decisions[]` whose why is quoted verbatim from a commit, plus `complete: false` for a shallow clone; `validateDecisions` rejects a decision whose sha is not a commit in the clone, whose what is not that commit's subject, whose why is not a quote, or whose alternative is not in the why. Git runs with a timeout, a scrubbed `GIT_*` environment and signature verification pinned off, and its log output is parsed NUL-delimited (TP-2808).

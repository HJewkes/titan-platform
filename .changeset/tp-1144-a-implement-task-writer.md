---
"@titan-design/evals": minor
---

TP-1144a: add the shared implement-task case writer. `writeImplementTaskCases` turns an accepted pull request into a private `titan.case/v1` for the new `units/implement-task` unit: the merge's first-parent tree under `trees/<id>` (no `.git`), hidden tests and carried support files from `@titan-design/fix-proof` `planFixProof` under `hidden/<id>`, each listed with path, sha256 and source PR. Private sources are filtered before writing and asserted absent before the first write. `seedWorkspace` makes a one-commit repo from a base tree, and `assertNoLaterHistory` refuses one that holds more. The out-dir guards move to `private/out-dir.ts`, and `bundle.ts` exports `archiveInto` and `verifyCommit`.

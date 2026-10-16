---
"@titan-design/fix-proof": minor
---

Add the mutation check's verdict (TP-2732 b). `classifyMutants` marks each mutation `killed` only when the tests failing under it, each with an assertion failure, are exactly its `kills`. `encodeMutantsReport`/`decodeMutantsReport` carry the mutants side's report to the judge. The `fix-proof/v1` line gains an optional `mutants` field, which the judge attaches only to a diff of test material alone that adds a spec.

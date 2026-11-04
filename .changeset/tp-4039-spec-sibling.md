---
"@titan-design/fix-proof": patch
---

A diff that changes only a mutation spec now plans the spec's sibling test (TP-4039). `planFixProof` takes an optional `headFiles` list, the paths at head beside the diff's specs; a spec whose one sibling test is listed there and not deleted adds that test to `tests`, so the spec's mutants are judged instead of the diff reading as `no-tests`. The runner and judge list each spec's directory at head and pass it in. Without `headFiles` the plan is unchanged.

---
"@titan-design/factory": patch
---

`titan-factory review` now reads a fix-proof standing without a Shepherd run (TP-4635): a `fix/` head branch or a `fix-proof` run at the head opens the gate, and the head's result line is read once through `readFixProof`'s own parser. A repo with no readable required checks takes its CI from the head's check runs instead of reading as pending, and the output's `CI:` line names the source.

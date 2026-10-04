---
"@titan-design/factory": patch
---

Refuse an explicit `--kind` on a repeat Shepherd registration that would move a `correctness` or `security` run to a kind that skips the fix-proof gate. The refusal exits 65 and names the stored and requested kinds. Same-gate and narrowing moves still apply.

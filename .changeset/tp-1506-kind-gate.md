---
"@titan-design/factory": patch
---

Refuse an explicit `--kind` on a repeat Shepherd registration that would move a `correctness` run to a kind that skips the fix-proof gate, or a `security` run to any other kind. The refusal exits 65, names the stored and requested kinds, and leaves a failed run untouched instead of replacing it first.

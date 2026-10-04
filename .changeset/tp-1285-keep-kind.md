---
"@titan-design/factory": patch
---

Keep the stored kind on a repeat Shepherd registration that omits `--kind`. Before, the repeat reset it to `unknown`, which skips the fix-proof gate. An explicit `--kind` still replaces the stored kind.

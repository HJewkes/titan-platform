---
"@titan-design/github": patch
---

Give the `execGh` timeout test a per-run sleeper marker, so a concurrent run of the suite on one host can no longer fail its "leaves no gh child alive" check or have its sleeper killed.

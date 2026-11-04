---
"@titan-design/fix-proof": patch
---

The judge now matches a source diff's mutation spec kills against the head report. A kill that names no test at head makes the verdict `error`, with a mutants error naming each stale kill. Before this, such a spec landed without being read.

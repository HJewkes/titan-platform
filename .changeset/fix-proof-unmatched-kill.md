---
"@titan-design/fix-proof": patch
---

A mutation spec kill that names no test in a baseline that loaded is now an `error` verdict naming the spec, mutation
and kill, with the full title when exactly one test ends with the bare one. It was a `baseline` outcome, which read as
a test that failed before the mutant rather than a kill that could never match.

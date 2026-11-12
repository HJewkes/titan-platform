---
"@titan-design/factory": patch
---

The toolchain sweep resumes a leftover adoption branch that holds only its own writes, and still refuses one with any other commit. It also throws when `openPr` reports a PR it did not open or a head outside the repo.

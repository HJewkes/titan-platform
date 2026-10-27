---
"@titan-design/code-graph": minor
---

Add extreme mutation findings (C-263 T3). `runExtremeMutation` body-deletes each changed function that a whole-suite coverage file (measured at head) saw run, runs fix-proof's head mode against the owning package's tests, and returns `pseudo-tested` and `test-deletion-candidate` warnings with a counts-only summary. `extremeFindings` is the pure reading; `coveredFunctionStarts` reads covered function start lines from Istanbul coverage; A function a test outside its package reaches is `unverified`, and a run whose failure list hit the cap never supports a deletion candidate. Nothing is scored and nothing is deleted.

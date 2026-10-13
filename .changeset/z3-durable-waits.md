---
"@titan-design/factory": patch
---

A wait that a restart re-dispatches now resumes its deadline from the step's first start, so it gets only the time it had left. This covers ci-wait (with its backlog ceiling), sh-fix-proof, sh-late-verdict, and sh-review's session-start wait for a reviewer that was already asked for. `codeRoute` bodies now receive a `StepClock`, and a step with a restart counts as a repeat even at attempt 0.

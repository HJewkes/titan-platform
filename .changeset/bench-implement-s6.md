---
"@titan-design/evals": patch
---

Add the bench I track: a per-arm copy of the prepared base with the design's implement prompt; scoring after exit on a fresh copy (touched-package build, own tests with one rerun of failing files, typecheck, then the withheld tests overlaid last) with a diff-size ratio and the patch kept; a post-hoc transcript audit that voids jobs reaching denied tools, proxy overrides or paths outside the job; and `bench oracle` for the no-model solvability check. `bench run` now selects the plan plugin for track p, and the plan-cases, judge-plan and report verbs are registered.

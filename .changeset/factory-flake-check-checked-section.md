---
"@titan-design/factory": patch
---

Shepherd's flake check reads the failing test files from the checked vitest section of a job log, so an Unhandled Errors log, a tail cut before the banner, or a non-vitest red no longer reads as outside the PR's diff.

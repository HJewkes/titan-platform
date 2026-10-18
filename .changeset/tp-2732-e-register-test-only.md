---
"@titan-design/factory": patch
---

`shepherd register --kind test-only` reads the PR's test-only diff before refreshing or restarting a run, so the kind guard names the first source path when it refuses (TP-2732 e). Once the kind is live, a correctness registration on a tests-only PR prints a hint to re-register as test-only. The CLI help and the Shepherd guide name the kind.

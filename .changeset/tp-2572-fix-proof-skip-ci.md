---
"@titan-design/factory": patch
---

Shepherd's fix-proof read no longer settles to `missing` when `.github/workflows/fix-proof.yml` exists at the PR's base ref (a head whose message carries a skip-ci marker, every run settled with no fix-proof run, or a deadline with no run): it reads `error`, as it does when the base branch or the workflow file cannot be read or the base branch is gone (TP-2572 a).

---
"@titan-design/factory": patch
"@titan-design/github": minor
---

`land` judges checks over every run at the head with `mergeReadiness` semantics: a red run of a required context blocks even beside a newer green one, a required context needs a run concluding `success` (neutral and skipped no longer pass), and only GitHub Actions runs count, so any red Actions run at the head is `ci-failed`. `@titan-design/github` exports `headCheckFindings`, the check evaluation `mergeReadiness` now delegates to, with `CheckFinding` and `HeadChecksInput`.

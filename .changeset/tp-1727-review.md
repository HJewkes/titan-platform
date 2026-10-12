---
"@titan-design/review-panel": minor
"@titan-design/factory": patch
---

Reviewers run no tests: the default reviewer test rule, now exported as `CI_REVIEWER_TEST_RULE`, has them cite the CI check-runs (name and conclusion) at the reviewed head and treat a missing, running or red required check as blocking. Shepherd uses it on every host, and its fixer rules name `pnpm test:affected` (TP-1727 slice 3).

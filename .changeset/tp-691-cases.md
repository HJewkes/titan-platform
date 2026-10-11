---
"@titan-design/evals": minor
---

TP-691b: add `titan-evals review-pr cases`, the private case builder for the `review-pr` unit. It turns outcome-corpus rows into private cases, with caught heads as FIX_FIRST plus the defect path and each PR's final clean head as MERGE. It plants six seeded controls (a deleted assertion, an inverted condition, a test that no longer bites) as tree fixtures with a gold path and line. It writes the cases, a suite with the review-pr checks, and a manifest to an empty out dir outside any git work tree, and the private exclusion runs before anything is written.

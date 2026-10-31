---
"@titan-design/factory": minor
---

Add `titan-factory review owner/repo#N [--head <sha>] [--json] [--wait-ci]` and `titan-factory review resolve <fingerprint>`. The CLI runs `@titan-design/review-workflow`'s runner on one PR head with ports built from `shepherd.review`, with no Shepherd run. It prints the outcome, the member dispatches and any fixer fingerprint. Only `MERGE` and `carried` exit 0, and `needs-update` is printed for the author, never acted on. The CLI posts nothing to GitHub. Its runs and parked fingerprints live in `review.sqlite3` beside the factory database.

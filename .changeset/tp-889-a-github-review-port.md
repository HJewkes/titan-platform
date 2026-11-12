---
"@titan-design/github": minor
---

The port, both wires and `fakeGitHub` gain pull request reviews. `createReview(repo, pr, { commitId, body })` posts an APPROVE pinned to `commit_id` and `dismissReview(repo, pr, reviewId, message)` dismisses one, both under the GitHub App token like `createCheckRun`, which now shares one App-scoping helper with them on each wire. `listReviews(repo, pr)` reads every review as `{ id, state, commitId, login, userType, body }`. The fake records the App's approval as `fake-app[bot]`, answers 404 and 422 as GitHub does on dismissal, and takes `createReviewFaults` and `dismissReviewFaults`.

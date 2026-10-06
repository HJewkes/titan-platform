---
"@titan-design/factory": minor
---

Shepherd publishes a `shepherd/review` check run per head through a new `sh-publish-review` step: `success` only for a MERGE at that exact head, `failure` for FIX_FIRST, and `action_required` for every other outcome, including a moved head, which is posted at the new head. The App comes from the optional `shepherd.reviewCheck` config (`appId`, `installationId`, `privateKeyPath`); without it, or when a post fails, the step records `published: false` and the run continues.

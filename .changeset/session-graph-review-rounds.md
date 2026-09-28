---
"@titan-design/session-graph": minor
---

Count review rounds over agent-chat verdicts and forge reviews under one rule. `ResolvedPr` gains optional `reviews` (`ResolvedReview`), which replace the PR's forge rows in `pr_review`; with `commitTimes` as well, `review_rounds_gh` is counted by the rule. New `projectReviewRounds` (run by `refreshCorpus` after `enrichPrs`) resolves each chat verdict's `pr_ref` by exact repo, repo hint, the sender's family links, then the sender's working directory repo, and writes `review_rounds_chat` and `review_rounds`. A changes-requested review counts when a later commit answered it, once per head across reviewers and surfaces; an approval never counts. Chat verdicts count only from senders whose profile passes the new `isReviewerProfile` refresh option (default `reviewer` or `*-reviewer`). `RefreshSummary` gains `reviews: { resolved, unresolved }`. Chat row keys now take their ordinal from the `review_verdict` event. Also exports `countRounds`.

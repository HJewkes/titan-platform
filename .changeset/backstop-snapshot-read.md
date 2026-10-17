---
"@titan-design/github": minor
---

Add `readBackstopSnapshot`: one repo's open PRs with head rollup contexts and reviews, recently closed PRs, and main history since a cursor, read over GraphQL with every range paged whole. A range past its cap throws `BackstopTruncated`, any GraphQL `errors` entry fails the read, and the snapshot carries GitHub's reported `rateLimit` cost. `snapshotRequests` and `graphqlPoints` compute the query's cost.

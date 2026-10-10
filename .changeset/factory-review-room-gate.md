---
"@titan-design/factory": minor
---

Shepherd's spawn gate defers a reviewer while `shepherd.review.maxConcurrent` (default 3) reviewers run, or while the filesystem that holds review checkouts has fewer free bytes than `shepherd.review.minFreeBytes` (default 5 GiB) or fewer free inodes than `shepherd.review.minFreeInodesPct` (default 15) percent of its total or twice the last checkout's, whichever is more. The deferral is logged with the reading and keeps the review's place in the oldest-first queue.

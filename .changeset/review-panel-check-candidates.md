---
"@titan-design/review-panel": minor
---

Add `parseCheckCandidates`, which reads a reviewer's optional `Check-candidates:` block (class key, route, rule sketch per finding) against the fixed `CHECK_CLASSES` vocabulary, keeping unknown keys as `other:<slug>` and dropping a faulty block whole with one closed warning. `reviewerBrief` now asks for the block through `CHECK_CANDIDATES_RULE` and lists every class key under its default route.

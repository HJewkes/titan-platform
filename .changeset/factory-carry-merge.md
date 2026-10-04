---
"@titan-design/factory": minor
---

Shepherd reuses a reviewer's MERGE across a tree-equal update-branch. At a new green head of a correctness, feature or refactor PR whose newest verdict is a MERGE, the `sh-carry` probe asks whether the head is exactly that reviewed head merged cleanly onto main; on equal the head takes a carried MERGE (merge evidence with the carry fact, and a comment naming both heads and trees) and no reviewer is dispatched. A hold satisfied by its named reviewer's MERGE moves to a tree-equal update the same way. A FIX_FIRST or other non-MERGE newest verdict, a security PR, or a PR with no registered kind never carries. Adds the `sh-carry-scope` step and a `carry` option on the review wiring for the probe's git.

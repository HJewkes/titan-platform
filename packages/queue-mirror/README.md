# @titan-design/queue-mirror

Projects a local queue of human-actionable items (agent approvals, endorsements, questions,
notices) into a Matrix `#queue` room, and folds the owner's reactions and replies back into
verdicts on that queue.

Tier 2 of the titan-platform DAG. Depends on `@titan-design/matrix-bus`. The root entry has
no `node:` import.

Reference: [site/reference/queue-mirror.md](../../site/reference/queue-mirror.md).

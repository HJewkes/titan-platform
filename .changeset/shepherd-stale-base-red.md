---
"@titan-design/factory": patch
---

Shepherd merges up a ci-red head whose failing checks all failed at the base its CI ran against, once that base has moved on, with no wake, repair or seat notice (TP-2562 a). The base-red hold record gains `stale`, and a freeze or base-red refresh records its own head so it is no foreign merge-up.

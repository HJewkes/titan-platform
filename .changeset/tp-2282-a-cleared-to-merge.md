---
"@titan-design/factory": patch
---

The Shepherd evidence comment for an allowed head now reads "Shepherd cleared to merge" instead of "Shepherd merged", because it is posted before the merge step runs. `evidenceComment(record, { mergeSha })` adds a `**Merged** at <sha7>` line after the headline for a caller that saw the merge land.

---
"@titan-design/factory": patch
---

Shepherd no longer closes a sliced task when an unsliced PR merges (TP-2829). A task whose plan has a `burndown-slices` block, or that is tagged `epic`, gets a note naming its unlanded slices and stays open.

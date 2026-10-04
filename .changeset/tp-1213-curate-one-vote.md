---
"@titan-design/memory": patch
---

`curate` now counts at most one `helpful` and one `harmful` vote per bullet per batch, whatever the `reason`, and an `add` that folds into an existing bullet counts as that bullet's `helpful` vote. Extra votes land in `report.skipped`.

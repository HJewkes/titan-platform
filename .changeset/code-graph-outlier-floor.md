---
"@titan-design/code-graph": minor
---

Add `floor` and `rankNonZero` to the `metric-outlier` check rule so a sparse metric whose percentile sits at or near zero no longer flags every non-zero node. Exempt Python's `except ImportError`/`ModuleNotFoundError` handlers (alone or paired, `pass` or a None-assignment fallback) from `swallowed_except`, since that is the standard optional-dependency idiom rather than a hidden error.

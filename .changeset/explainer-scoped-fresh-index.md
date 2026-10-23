---
"@titan-design/explainer": patch
---

`enrichStructure` now indexes only the files the review read when it has to index a clone from scratch. The file list comes from the file nodes of the review's own `graph.db` (`reviewScopeFiles`), and `scopedSource` keeps vendored trees out of both the walk and the type checker, so a clone with thousands of vendored files no longer exhausts memory. With no review index to take a file list from, the whole clone is indexed and `W-INDEX-SCOPE` says so (TP-4089).

---
"@titan-design/code-graph": patch
---

`indexPaths` outside a git checkout no longer re-probes git for churn history and HEAD after the toplevel probe has already found no repo. The snapshot is unchanged: both probes returned nothing there.

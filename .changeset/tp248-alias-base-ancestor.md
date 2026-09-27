---
"@titan-design/code-graph": patch
---

Only use a prior snapshot as the alias base when its commit is an ancestor of the indexed commit. A force-pushed ref no longer yields spurious rename aliases, or carried-over violations, from an unrelated pre-rewrite snapshot.

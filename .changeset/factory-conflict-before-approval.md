---
"@titan-design/factory": patch
---

Shepherd checks GitHub's mergeable state against the current base before it opens approve-merge, and again once the owner
approves. A head that conflicts goes back to the implementer as a conflict wake. Before, an approval could land on a head
whose base had moved into a conflict, and the run then failed at update-branch.

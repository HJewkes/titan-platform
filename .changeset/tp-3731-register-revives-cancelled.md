---
"@titan-design/factory": patch
---

`shepherd register` now revives a cancelled run whose pull request is open again (TP-3731). Shepherd cancels a run only when its PR read merged, closed or gone, so a repeat register starts a new run at the PR's current head, as it does for a failed run, and the registration keeps its holds (an owner-asked hold included), kind and authors. A cancelled run whose PR is closed still comes back unchanged.

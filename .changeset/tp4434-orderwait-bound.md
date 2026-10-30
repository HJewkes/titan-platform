---
"@titan-design/factory": patch
---

Shepherd now limits a conflicted PR's merge-order wait to the 15 min merging stall limit (TP-4434). Before, a PR queued behind a reservation that was held through a long review round sat in `merging` until the TTL. Now, once the limit passes, the PR leaves the wait and goes through the existing conflict wake. A wait that is still under the limit keeps the TP-4098 order.

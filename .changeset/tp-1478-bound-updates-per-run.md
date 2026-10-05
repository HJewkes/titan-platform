---
"@titan-design/factory": patch
---

Shepherd counts branch updates per run instead of per land round, so a head that goes behind during a review no longer resets the stuck-behind bound, and a behind head whose mergeable_state is still unknown no longer burns a land round per read.

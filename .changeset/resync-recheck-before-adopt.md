---
"@titan-design/factory": patch
---

Shepherd rechecks runs that start resync could not cancel (a live foreign lease) against their PR right before adoption, so a run whose PR merged or closed outside Shepherd is ended instead of driven to sh-landed.

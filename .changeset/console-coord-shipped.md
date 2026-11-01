---
"titan-console": minor
---

The new `coord.shipped` read lists the day's PRs that Shepherd's finished runs record as merged (TP-1717). It returns the cached theme digest from the state directory's `shipped` folder when one exists, marks it stale when the merged set has changed since, and never calls GitHub or a model.

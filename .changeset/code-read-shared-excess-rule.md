---
"@titan-design/code-read": patch
---

`excessOf` and a finding's `status` now use code-graph's `violationExcess` and `compareExcess`
instead of a local copy of the same rule, so they return the same outputs as before.
`changes.get` and `paths.impact` now pass each finding's rule type and threshold to
code-graph's bucketing. A `metric-min` finding whose value falls is now counted as worsened,
not improved, which matches the status `findings.list` already gave it.

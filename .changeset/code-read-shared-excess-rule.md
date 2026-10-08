---
"@titan-design/code-read": patch
---

`excessOf` and a finding's `status` in `findings.list` now use code-graph's `violationExcess`
and `compareExcess` rather than a local copy of the same rule, so their outputs are unchanged.
`changes.get` now passes each finding's rule type and threshold to code-graph's bucketing. A
`metric-min` finding whose value falls is now listed under `worsened`, not `improved`, as
`findings.list` already reported it.

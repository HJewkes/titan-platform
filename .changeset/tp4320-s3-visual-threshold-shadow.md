---
"@titan-design/factory": minor
---

Add `shepherd.visualThreshold`, a per-repo config key read live at each merge evidence step, with mode `off` or
`shadow`. Under `shadow` the evidence records `visualDelta`: the snapshots the PR changes, added or removes, and the
public API, token and harness paths it touches. No blob is read yet, so every changed snapshot records as `unmeasured`
with reason `not measured yet`. The measuring caps (`maxSnapshots`, `maxBytes`, `maxPixels`, `maxTotalPixels`) have
ceilings config cannot raise, and the record's schema bounds every list and string, so the evidence comment stays under
GitHub's size limit. The merge decision is unchanged.

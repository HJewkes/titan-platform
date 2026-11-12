---
"@titan-design/factory": patch
"@titan-design/coordinator": patch
---

Add a low-tier policy hold (TP-5403 slice B) that ships in shadow. Under `shepherd.gateReset.lowTierPolicy: on`, a low-tier policy touch is held `g10-review` instead of `g10-adversary`, so it lands on one opus MERGE at its head with green CI and no owner gate; the release records the rule `g10-review/low-tier`, the timeline shows it as a `decision` entry, and the merge evidence records `lowTier`. The switch (off, shadow, on) is a new editable factory row. Absent means `shadow`: the run keeps its `g10-adversary` hold and the reason names the low tier it would have had. Setting `on` is an owner config edit that follows the owner's decision on which gate code may go low.

No file in the classifier's own import closure (`g10-low-tier-closure.json`: the classifier, the registration hold, their file and line-count readers and the workspace package sources they import) goes low; a test recomputes the closure and fails when the list falls behind. Code that calls the rule or writes the verdicts the release reads is not in that closure.

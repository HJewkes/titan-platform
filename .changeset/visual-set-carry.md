---
"@titan-design/factory": patch
---

Shepherd: when the owner accepted a red head's regenerated baselines, a later head that commits exactly that set (every changed path in the set, each file at its accepted blob, each removed file gone, nothing else) has its visual approve-merge gate answered `merge` by code and logged as step `sh-approval-carry:set:<head>`. Under `shepherd.visualSetCarry: shadow` the step records whether the set would carry and the owner is still asked. With the flag `off`, the default, nothing changes. A set is checked once. An approval that came from a set does not yet follow a later merge-up.

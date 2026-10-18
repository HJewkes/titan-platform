---
"@titan-design/factory": patch
---

Shepherd: when the owner accepted a red head's regenerated baselines, a later head that commits exactly that set (every changed path in the set, each file at its accepted blob, each removed file gone, nothing else) has its visual approve-merge gate answered `merge` by code and logged as step `sh-approval-carry:set:<head>`. Under `shepherd.visualSetCarry: shadow` the step records whether the set would carry and the owner is still asked. With the flag `off`, the default, nothing changes. The set carries only onto a gate into the base its red head's CI read was judged on. It is used up once it is checked, or once the owner answers a visual gate themselves, and a later answer at the accept gate replaces it. An approval that came from a set does not yet follow a later merge-up.

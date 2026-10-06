---
"@titan-design/factory": patch
---

A held Shepherd run waiting in its merge step now names the hold in its next action and no longer trips the merging stall alarm; its phase stays `merging`. A merge waiting at a head that a fix round replaced ends once the hold's reviewer sends MERGE at the new head.

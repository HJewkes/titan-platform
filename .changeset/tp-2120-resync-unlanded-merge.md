---
"@titan-design/factory": patch
---

Shepherd resync now ends a run whose PR was merged outside Shepherd even when the run recorded a merge step that landed nothing, such as one a g10 hold refused.

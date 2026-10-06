---
"@titan-design/code-graph": patch
---

Derive `NodeRole` and `NodeKind` from exported `NODE_ROLES` and `NODE_KINDS` arrays, so `excludeRoles` accepts every role (including `generated` and `script`).

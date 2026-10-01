---
"@titan-design/factory": patch
---

Import `routedRunner` from `@titan-design/workflow` and delete the local adapter. Factory still re-exports the routing types. Registration now also refuses two routes that match the same step id.

---
"@titan-design/code-graph": minor
---

Export `bucketViolations`, the store-free core of `diffCheckResults`, from the root and from the browser-safe `./analysis` subpath. It buckets two violation lists as new, resolved, unchanged, worsened, or improved, with an optional id resolver for moved files. `violationKey` and `rebasedViolationKey` now accept any value with `ruleId`, `nodeId`, and `destinationId` (`ViolationIdentity`).

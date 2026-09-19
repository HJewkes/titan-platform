---
"@titan-design/code-graph": minor
---

Add `snapshotViolations(store, snapshotId, rules)`: every rule's violations in one snapshot, with no baseline. It takes any `RuleStore`, meaning a store with `listNodes`, `listEdges`, and `listMetrics`, instead of the concrete `CodeGraphStore`. code-read derives its findings with it and keys them with `violationKey`, the same key the ratchet uses.

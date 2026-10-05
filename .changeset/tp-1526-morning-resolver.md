---
"@titan-design/decider": minor
---

`morningSource` takes an optional `resolveInitiatives` resolver. A row whose item names exactly one initiative is claimed for it, an item naming a human-only initiative is excluded, and any other row stays unclaimed. `joinMorning` returns the joined `items`, `onCounts` also reports `unresolved`, and `taskIdsIn` and `initiativesOfTaskIds` build a resolver from task ids.

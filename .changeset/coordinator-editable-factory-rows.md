---
"@titan-design/coordinator": minor
---

`EDITABLE_FIELDS` rows may carry any zod schema, not only a number: `bounds` is now optional and present on numeric rows only, and `checkEditableValue` returns an `EditableValue` (number, string or string list). Add factory rows marked `live`: `shepherd.gateReset.noReproProceed` and `heldRepair` (`off`/`on`), `twoMergeRelease` (`off`/`shadow`/`on`), `shepherd.review.adversaryProfile` (one profile name), `shepherd.review.fallbackConfigDirs` (up to 16 absolute paths) and `shepherd.review.maxConcurrent` (1..64). Add `shepherd.spawnGate.buildLoad5` beside `load5`, both still `restart`. Paths the factory writes, secrets and any other `shepherd` key stay not editable.

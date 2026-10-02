---
"@titan-design/code-graph": minor
---

Add the per-unit doc gate. `unitProvenance({ unit, footprints, snapshot, model })` records a unit's symbol-set hash with the snapshot's commit hash, and `gateUnits({ prior, units, footprints })` returns the units to regenerate (`new` or `changed`), the units to skip, and the prior units that are orphaned. When every hash matches its prior record, `regenerate` is empty and the caller makes no LLM call.

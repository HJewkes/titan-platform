---
"@titan-design/factory": minor
---

Report owner friction. `shepherd stats` now also prints, per UTC day, the gates an owner class resolved and, per gate kind, the median and maximum hours gates waited on the owner, with open gates counted to now; a gate any other actor resolved is not counted. The morning digest shows both as an "Owner friction" section. `shepherd stats --json` now returns `{ merges, ownerFriction }` instead of the bare merge rows.

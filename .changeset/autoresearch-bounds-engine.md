---
"@titan-design/autoresearch": minor
---

Enforce `bounds.json` on real diffs. Add `parseUnifiedDiff`, `postCheck` (frozen, class, new-file, required-test, case-name, stray-literal and param checks, one recorded row each, plus the measured diff size), `changedParams` and `frozenOverlap`. `BoundsSchema` reads `integerParams`, `diff`, `test` and `banned` (each ban as prose or data, and a data-form `literalsOutsideConfig.allowed` list). `TargetSchema` reads `frozen`, and a class that names a frozen file stops the run before the baseline. A guard can now be `{slack, direction}`, so a `max` metric's guard rejects a fall. A winner within one σ of the strongest with a smaller source diff moves the ratchet. `ArResultSchema` keeps `rung`, `evaluator_pin` and `artifact_dir`. A blank `differsFrom` no longer clears a dead end.

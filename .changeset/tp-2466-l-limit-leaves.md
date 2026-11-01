---
"@titan-design/factory": patch
---

Move `MAX_NOTE_CHARS` into `note-limits.ts` and the spawn limits (`SpawnLimits`, `MachineReadings`, `DEFAULT_SPAWN_LIMITS`) into `shepherd/spawn-limits.ts`, both import-free leaves, so `gate-answer-check` and `machine-stop` no longer close value-import cycles. No behaviour change.

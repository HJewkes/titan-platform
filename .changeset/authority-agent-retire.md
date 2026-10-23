---
"@titan-design/authority": minor
---

Add the `agent-retire` action class (TP-3622) with seven rows, RET-OT to RET-DC. The owner may retire an agent from the console (RET-OR allow), conditioned on a plain retire of an agent whose session has exited and that works on no live Shepherd run. Coordinators and automation may retire agents; workers, headless sessions and the decider may not. `destructive-local` is unchanged, so DSL-OR still denies every other local destructive action to owner-remote. The table now holds 49 allow, 6 gate and 69 deny rows.

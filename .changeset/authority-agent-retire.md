---
"@titan-design/authority": minor
---

Add the `agent-retire` action class (TP-3622). RET-OR lets the owner retire an agent from the console, conditioned on a plain retire of an agent whose session has exited and that works on no live Shepherd run. Every other actor's row copies its `destructive-local` row word for word, so retire policy changes for owner-remote only. `destructive-local` is unchanged, so DSL-OR still denies every other local destructive action to owner-remote. The table now holds 51 allow, 6 gate and 67 deny rows.

---
"@titan-design/factory": minor
---

Add the real autoresearch evaluator ports. `evaluatorPorts` pins a run to an evaluator checkout and an integration checkout of the target clone, reads `target.json` and `bounds.json` at the pin, refuses a class glob that reaches a frozen file in the pin's file list, and points the ratchet ref at the pin. Every eval and micro run is guarded on both sides: the evaluator checkout must be clean and its frozen files must hash as they did at the pin. L0 runs the bounds post-check on the real diff, the unit suite and the test proof (skipped for excepted classes), each row timed, with the first failure as the code. The ratchet uses the pinned target's prefix, and the archive writes `round-<n>.tgz` with a `SHA256SUMS` line. `arProductionPorts` composes them with the agent ports. The autoresearch routes now record `startedAt` and `restarts`, pass dispatch usage to the runtime, and record the ratchet's move.

---
"@titan-design/explainer": minor
---

Add the sim kit's contract for `sim` beats, in TypeScript only. A `SimModel` simulates from the seed's `seededRandom` generator, and `runPure` refuses a model that reaches for `Math.random`, the clock (`Date.now`, `Date()`, `new Date()`, `performance.now`, `process.hrtime`) or `crypto`'s random calls. It also runs the model twice and refuses it when the two outputs differ, which catches any source it doesn't trap. `sweepSim` runs a model over one swept param and an optional facet, and refuses a param the base params don't own, seeding each point by its value so adding a point leaves the others unchanged. `freezeSim` validates the result as an `explainer.sim-trace/v1` trace (at most 64 steps a run) and keys it by the sha256 of its canonical JSON. `loadSims` reads `doctrine/sims/*.yaml` (`sim-model/v1`), and `checkSims` reports drift between it and `SIM_MODELS`.

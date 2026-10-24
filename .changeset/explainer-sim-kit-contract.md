---
"@titan-design/explainer": minor
---

Add the sim kit's contract for `sim` beats, in TypeScript only. A `SimModel` simulates from the seed's `seededRandom` generator, and `runPure` refuses a model that calls `Math.random`, `Date.now` or `performance.now`. `sweepSim` runs a model over one swept param and an optional facet, seeding each point by its value so adding a point leaves the others unchanged. `freezeSim` validates the result as an `explainer.sim-trace/v1` trace (at most 64 steps a run) and keys it by the sha256 of its canonical JSON. `loadSims` reads `doctrine/sims/*.yaml` (`sim-model/v1`), and `checkSims` reports drift between it and `SIM_MODELS`.

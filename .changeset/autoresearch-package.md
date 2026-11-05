---
"@titan-design/autoresearch": minor
---

Add `@titan-design/autoresearch`: the autoresearch engine (queue, Thompson selection, fidelity ladder, noise-banded keep rule, registries, digest and the `mapItems` recipe) against `ArPorts`. It is target-agnostic: results are `ar-result/v2` with named `metrics`, `gates` and `violations`, and the keep rule reads the target's `metric` spec (`primary`, `guards`, `zeroTolerance`, `allGate`, `noOp`). Diff size is recorded on outcomes, never capped. Inspired by Andrej Karpathy's autoresearch (MIT); no code copied.

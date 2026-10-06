---
"@titan-design/code-read": minor
---

Add the `packages.stats` command (contract 0.1.8): code-graph's `computePartitionQuality` over a snapshot's package roots, either the `packages` given or every root the product's `layered-deps` rules declare. Per package it returns the file count, internal, outgoing, and incoming edges, cohesion, instability, abstractness, the instability band, and flags, plus its declared tier as `layer`, or `layer: { status: "undeclared" }` for a root no tier names. It also returns the package-to-package edges, the snapshot's modularity, and the count of files under no root. A `ModelRule` now carries a `layered-deps` rule's `layers`; `finding.get` still returns the rule without them. The live handler and the static resolver return the same result.

---
"@titan-design/retrieval": minor
---

Add `walkGraph({ neighbours, degree, degrees? }, seeds, { hops, hubDegree, maxNodes })`, a breadth-first walk over any adjacency that returns a hub (a non-seed node with degree at least `hubDegree`) but never expands it, so one busy node cannot flood the result. `hubDegree` defaults to `defaultHubDegree(degrees)`, max(50, p99 degree), also exported. `expandGraph` is now the edge-table adapter over it and gains optional `hubDegree` and `maxNodes`; without them its output is unchanged. The hub cap is adapted from graphify under Apache-2.0, and the package now ships a `NOTICE`.

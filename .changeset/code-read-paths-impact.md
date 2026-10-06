---
"@titan-design/code-read": minor
---

Add the `paths.impact` command (contract 0.1.7): given repo-relative `paths` and an optional `baseline`, each file's hotspot complexity, its score and rank as `hotspots.list` ranks it at `window`, and its open findings, plus a rollup. With a comparable baseline each row gets a score, complexity, and findings delta, findings bucketed by code-graph's `bucketViolations` as `changes.get` buckets them; without one `delta` is absent, and across index versions it is null. A path the snapshot holds no file for answers a `not-indexed` row and one outside the repo an `outside-repo` row, never an error; a leading `./` is dropped and absolute paths are read under the optional `root`. The live handler and the static resolver return the same result.

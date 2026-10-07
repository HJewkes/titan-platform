TP-1854: the dag-check job re-indexes the whole tree cold on every run (about 250 s for the head index; 2 s when the tree is unchanged).

- `scripts/dag-check-self.mjs` takes `--seed-db <path>`: it starts from a restored graph, falls back to a cold index if the file is unusable, and prunes to the head and baseline snapshots so the cache does not grow.
- `ci.yml` restores the graph with `actions/cache/restore` before "Check the package DAG" and saves it with `actions/cache/save` on pushes to main only. Key: hash of the code-graph, code-parser, embed, retrieval and store-sqlite sources, `dag-check-self.mjs` and the lockfile, plus the ISO week, plus the commit sha; restore-keys drop the sha. The week means the first main run of each week indexes cold, so a stale chain lasts at most a week.
- Reuse is proven safe by `packages/code-graph/src/check/db-reuse-check.test.ts`: index tree A, then B (one file added, one changed, one deleted) on A's DB. The snapshot (nodes, edges, metrics) and the check violations equal a cold index of B.
- No required check name changes; the codewatch summary step is untouched.

Timings: to follow from the PR's CI run (cold; a PR can only read a cache a main push saved).

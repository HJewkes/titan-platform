---
"@titan-design/session-read": minor
"@titan-design/session-graph": minor
---

Restore the `built_on` relation (pr --built_on--> branch). The `pr_create` event's command half now carries `headRef` and `base`, read from `gh pr create --head`/`-H` and `--base`/`-B`, or from the checked-out branch when no head is named and nothing in the command switches it; `RELATIONS.BUILT_ON` documents the relation. session-graph migration 16 stores the head, base and call time on `pr_create_observation`, and `reconcile` writes one live `built_on` edge per create whose result named a PR, with the base in `attrs` and a `builtOn` count. A failed create writes no edge. Rows indexed before migration 16 gain edges on the next rebuild.

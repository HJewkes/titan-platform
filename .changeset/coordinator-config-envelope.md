---
"@titan-design/coordinator": minor
---

Add `coordinatorConfigSchema` and `checkCoordinatorConfig` for the `titan-coordinator/v1` document: owner, repos, seats, limits and policy in one file. Seats reuse `seatConfigSchema`, policy reuses the charter hard stops and defaults, and limits is agent-dispatch's `limitsSchema`, now a dependency. The check never throws and names the key path of each cross-reference error: an unknown pool, repo or hard stop, an unshared repo, a duplicate prefix, a seat `config_dir`, and anything other than exactly one attended seat named by `owner.seat`.

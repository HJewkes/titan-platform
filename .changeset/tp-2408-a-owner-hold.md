---
"@titan-design/factory": patch
---

Add the `owner-asked` Shepherd hold class, kept in its own slot on the registration (migration 22, additive). The merge guard checks it before any satisfaction, so `sh-g10-release`, a `--reviewer` MERGE (at the head or carried to a tree-equal head), `release`, and a re-hold of another class all leave it in force. `shepherd release` refuses `--class owner-asked` and a bare release of a PR held by the owner alone; `shepherd hold` refuses an owner-asked hold with `--reviewer`. Only `ShepherdStore.releaseOwnerHold` lifts it. Cleanup of a PR merged around one records `owner hold bypassed: merged outside Shepherd`.

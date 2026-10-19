---
"@titan-design/factory": minor
---

TP-3639: `titan-factory shepherd freeze <owner/repo> --reason <text>` and `shepherd unfreeze <owner/repo>` set and lift a coordinator's merge freeze on a whole repo; `shepherd freezes` lists them. While a repo is frozen no Shepherd run merges into it, though runs keep reviewing and CI keeps running; unfreeze lets waiting runs merge on their next step. The freeze is stored in the factory database (migration 33, `shepherd_repo_freeze`), is checked by the same merge guard as the main-red freeze, and is independent of it. `status`, `list` and `timeline` rows carry it as `repoFrozen`.

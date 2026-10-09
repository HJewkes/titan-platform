---
"@titan-design/pm": minor
---

Add `CategoryRegistrySchema` for the closed `kind`, `status`, `cos` and `area` axes (it must list status `open`, `done`, `wont-do` and `icebox` and kind `epic`), `categoriesPath(activeRoot)`, `parseCategoryRegistry`, which reads a missing file as a null registry, and the pure `checkCategories(task, registry)`, which returns `unknown-category` and `cos-fixed-without-due` errors. `TaskSchema` gains optional `kind`, `cos`, `area` and `due`, and `status` is now any non-empty string: a null registry checks it against `BUILT_IN_STATUSES` (`open`, `done`).

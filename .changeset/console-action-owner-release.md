---
"@titan-design/factory": patch
---

`POST /owner/console-action` also takes an `owner-release` action record: it lifts the owner-asked hold on the record's PR, and only that hold, as owner-remote from the console inbox at the head the owner confirmed. The answer is `released` (with any hold still in force as `stillHeld`), `already` for a replay of the same record, `moved` when GitHub's head differs, `gone` for a PR with no owner-asked hold, and `refused` for a record that names its own resolver.

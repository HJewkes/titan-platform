---
"@titan-design/store-sqlite": minor
---

Add `sqlMigration({ version, name, sql })`, a migration whose SQL is both what runs and its `definition`, and export `definitionHash` so a drift check can read the recorded hash.

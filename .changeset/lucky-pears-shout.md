---
"@titan-design/store-sqlite": patch
---

Refuse a migration whose recorded name differs from the declared name.

`runMigrations` now compares the `name` of an already-applied version against the
name recorded in `_migration` and throws `MigrationIdentityError` when they differ,
instead of silently treating the version as applied. A migration that declares no
name, or one whose recorded name is null, is never compared.

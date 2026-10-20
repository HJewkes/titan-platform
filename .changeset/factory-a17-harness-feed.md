---
"@titan-design/factory": patch
---

Add the A17 dual-mode test harness (TP-3808): `a17Event` registers an event case under both `sources=webhook` and `sources=polling`, and `factoryMigrations()` is exported from the host so the harness opens the same schema as serve.

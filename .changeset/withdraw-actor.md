---
"@titan-design/owner-queue": minor
"titan-console": minor
"@titan-design/factory": patch
---

Record who actually withdrew an inbox deposit (TP-4121). `withdrawDeposit`, `restoreDeposit` and
`withdrawMatching` take a required `actor`, refuse a blank one, and write it beside the asker
(`by`) in the `<id>.withdrawn` marker and every `withdrawals.jsonl` row. A marker from before
this has no `actor` and still reads. `WithdrawnItem` gains an optional `actor`, which the
console's inbox read model fills from the marker.

`titan-console inbox withdraw|restore|withdraw-matching` take a required `--actor <seat>`; a
missing one exits 65 with one line on stderr. The console updater and the factory deployer
record their own names as actor when they auto-withdraw resolved alarms.

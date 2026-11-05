---
"@titan-design/factory": patch
---

Shepherd's ci-red waits for a new head now re-run the base-red hold decision while the head is unchanged. `ciFailedRoute`, `afterFixerExit`, `afterHeldWake` and `repairGate` pass the failing check names into `await-new-head`, and serve wires the new `inheritedRedCheck` into land-pr's wait. The check reads the base head on each due tick and decides again only when the base moved or 30 minutes passed. Once every failing check is the base's red, a stale base's or a frozen main's, the wait ends `baseRed`. The next round's hold then merges the head up for fresh CI, with no implementer push and no repair spent. A head with a failure of its own still waits for a new head.

---
"@titan-design/dispatch-ledger": minor
---

Add the ledger store (TP-2578 c): the `LedgerStore` interface with `memoryLedgerStore` and a `SqliteLedgerStore` on `dispatchLedgerDdl()` tables, whose writes check a revision (`StaleRevisionError`) and the phase edges, plus `importLedgerJson` and `normalizeLedger`.

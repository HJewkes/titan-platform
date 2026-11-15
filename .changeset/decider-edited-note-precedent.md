---
"@titan-design/decider": patch
---

Carry an edited decision note's new answer into the precedent ledger. A changed note is appended as a superseding revision row (`<key>@<n>`), so `LedgerStore.get` and `rows` return the current text while the ledger stays append-only and unchanged notes and active-work v1 rows still dedupe.

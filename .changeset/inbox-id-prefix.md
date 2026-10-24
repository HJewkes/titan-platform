---
"@titan-design/owner-queue": patch
"titan-console": patch
---

Let `withdrawDeposit` and `restoreDeposit` take a short deposit id (TP-4122). Besides the full
`deposit:<32 hex>`, either takes a hex prefix of at least 8 digits, bare or after `deposit:`, that
starts exactly one deposit in the spool, and reports the full id. An ambiguous prefix is refused
with every full id it matches; no match is `unknown` with `unknown id <x>; full form is
deposit:<32 hex>`. Only an id of another item kind (`gate:`, `round:`) is refused as not a
deposit. The asker, actor and answered checks run on the resolved deposit as before.

`titan-console inbox withdraw|restore` pass the id through: an ambiguous prefix exits 65 and an
unknown one 66.

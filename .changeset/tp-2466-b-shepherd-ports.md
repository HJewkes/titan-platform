---
"@titan-design/factory": patch
---

Move the shepherd port interfaces (cleanup, exit notice, spawn gate, roster, suite rules, review checkout removal) into one `shepherd/ports.ts` leaf, and drop the transitional `ShepherdServices` and reviewer-type re-exports. Types only; no behaviour change.

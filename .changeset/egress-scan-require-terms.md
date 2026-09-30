---
"@titan-design/egress-scan": patch
---

`TITAN_EGRESS_REQUIRE_TERMS=1` now fails closed: `CI` in the environment no longer skips term loading, and a term list with zero terms exits 2 instead of passing.

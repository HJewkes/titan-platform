---
"@titan-design/factory": patch
---

The marker shadow now meters the `notAfter` advisory evaluation against the entry's budget. Each advisory evaluation counts in the `entry-end` counters, and a spent meter skips it and writes one `budget-exceeded` row. The live call is unchanged.

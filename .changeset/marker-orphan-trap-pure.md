---
"@titan-design/factory": patch
---

Add the pure call-site orphan trap: an entry log of visited call sites and how far into the run's record the entry reached, and `findOrphans`, which picks the valid markers this run left at a call site the entry passed without visiting. Nothing calls it yet; the host wiring follows.

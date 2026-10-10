---
"@titan-design/factory": minor
---

A `g10-adversary` hold that names a reviewer no longer takes that reviewer's verdict as Shepherd's review: Shepherd spawns its own reviewer at the head, and the named reviewer's MERGE only satisfies the hold. The new `titan-factory shepherd review owner/repo#N` asks for Shepherd's own fresh review at the PR's current head, once per head; a held run waiting to merge at that head sets its verdict aside and reviews again. Migration 18 stores the ask on the registration.

---
"@titan-design/factory": minor
---

A `g10-adversary` hold that names a reviewer no longer takes that reviewer's verdict as Shepherd's review: Shepherd spawns its own reviewer at the head, and the named reviewer's MERGE only satisfies the hold. The new `titan-factory shepherd review owner/repo#N` asks for Shepherd's own fresh review at the PR's current head, once per head; a run waiting to merge at that head, held or not, sets its verdict aside, ends the land round so the policy or the owner decides again, and reviews again. A MERGE that stands for an asked head is never carried to a later head. Retries at an asked head stay Shepherd's own, a `g10-review` hold that names a reviewer no longer releases itself on Shepherd's own MERGE, and the Version Packages run refuses an ask. Migration 18 stores the ask on the registration.

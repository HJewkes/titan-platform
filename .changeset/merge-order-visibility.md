---
"@titan-design/factory": minor
---

Shepherd's merge order is now visible, and a seat can clear it by hand (TP-4098 slice D). `shepherd status` names `merge order: waiting behind #N` on a waiting row and shows the reservation on the reserving row. The timeline logs `order-reserve`, `order-release` and `order-expired` events (migration 41 widens the event kinds). `titan-factory shepherd order [owner/repo]` lists reservations with their age, state, blockers and waiters, and `shepherd order clear owner/repo#N --reason` ends one, logged with the caller. A reservation past its TTL is expired once by its own run in the new `sh-order-expire` step, which tells the seat once. The order wait also stops waiting on an `ahead` run that left its merge step without merging (TP-4103).

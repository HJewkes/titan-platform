---
"@titan-design/owner-queue": minor
---

Add the deposit format any agent can file into the owner inbox. `ownerItemDepositSchema` is a strict subset of `OwnerItem`: a deposit that carries `id`, `status`, `answer`, `route`, `authority`, `lint` or a hidden recommendation is refused, and `asker` and `depositId` (the idempotency key) are required. `fromDeposit(deposit, now)` parses a deposit and returns the open `OwnerItem` it files, with source `deposit:<asker>/<depositId>`, a lens derived from its kind (`DEPOSIT_LENS`) and an id from `depositItemId`. `SOURCE_SYSTEMS` gains `deposit`. Also exports the `OwnerItemDeposit` type.

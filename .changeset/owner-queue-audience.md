---
"@titan-design/owner-queue": minor
---

Add an optional `audience` (`owner` | `operator`, absent means owner) to `OwnerItem` and `OwnerItemDeposit`, with `forAudience`/`audienceOf` and a `readSpool(dir, { audience })` filter, so a burndown can file operator steps without an `[operator]` summary prefix.

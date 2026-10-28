---
"titan-console": minor
---

Record a plan round's approval (TP-4357). A round's `planApprovals` binds a pick-one to a TP-4284 plan-approval entry. The owner's approve pick, from their own `rounds.submit`, writes one `plan-approval` action record with the round id and posts it to the factory's `/owner/console-action`. The start-up sweep only reposts a record that submit wrote, so a relayed or decided answer records nothing.

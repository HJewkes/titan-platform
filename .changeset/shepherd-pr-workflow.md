---
"@titan-design/factory": minor
---

Add the `shepherd-pr` workflow. It waits in `sh-await-pr` for a registered branch's PR, then lands the PR round by round under `shepherdGatePolicy`. A red head, a dirty PR, or a `FIX_FIRST` or `NO_REPRO` review wakes an agent first; an unhandled wake falls back to land-pr's `ci-failed` gate or the owner's merge gate. The review runs at every green head before the merge decision. Registrations live in a `shepherd_registration` table (migration 4) in the factory database, and every merge goes through a hold, so a held PR never reaches the port's merge. `ShepherdPhases` requests now carry `repo`, `pr` and `round`, wake gains the `fix-proof` kind, and `Verdict` gains `NO_REPRO`. Route sets can carry a `DatabaseTenant`, whose migrations and binding the host applies.

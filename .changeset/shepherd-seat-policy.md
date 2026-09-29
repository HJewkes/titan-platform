---
"@titan-design/factory": minor
---

Add Shepherd seat policy: `shepherd/seats.ts` reads autonomy-seat/v1 seat files and the charter's hard stops, and `shepherd/policy.ts` resolves the effective per-PR policy as the seat default narrowed by the registration, refusing denied repos. `shepherdGatePolicy` maps it to a `GatePolicy`. Config gains `shepherd.seatsDir`, `shepherd.charterPath` and `shepherd.hardStopRepos`. Every input fails closed: an invalid seat file or configured charter throws `SeatBookInvalid`, a repo key that is not a bare `owner/name` is denied, and a request that does not match `RequestedPolicySchema` throws `RegistrationRefused`. A repo several seats list gets the grants they all share.

---
"@titan-design/factory": patch
---

A MERGE whose only unmet attestation rows are `no-meeter` (the correctness reviewer declined to attest) now goes back to
the implementer once, asking it to replace the claim with a step version bump, instead of opening the owner's
approve-merge gate; any other unmet reason, an unhandled wake, or a second decline asks the owner as before.

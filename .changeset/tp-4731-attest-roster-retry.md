---
"@titan-design/factory": patch
---

The merge-evidence step's attestation judge reads the reviewer roster with the same waits the review intent uses (`whileRosterSlow` over `whileBrokerBooting`), so one slow broker answer no longer gates the head. A broker failure that outlasts those waits, or any failure in the external-review transient list, fails the step and the run instead of opening an owner approve-merge gate (decision 515). A store, registration or roster that fails for any other reason still gates as `attestation unmet: unread`.

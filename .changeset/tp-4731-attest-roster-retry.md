---
"@titan-design/factory": patch
---

The merge-evidence step's attestation judge reads the reviewer roster with the same waits the review intent uses (`whileRosterSlow` over `whileBrokerBooting`), so one slow broker answer no longer gates the head. A broker failure that outlasts those waits, or any failure in the external-review transient list, fails the step and the run instead of opening an owner approve-merge gate (decision 515). A store, registration or roster that fails for any other reason still gates as `attestation unmet: unread`. The lineage read (`agent ls --json --include-retired`) is read with the same waits and gets its own timeout, `DEFAULT_LINEAGE_TIMEOUT_MS` (90 s, overridable as `lineageTimeoutMs`), instead of the live roster's 10 s, which it outgrew on a busy broker.

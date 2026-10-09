---
"@titan-design/hitl": minor
---

A gate store takes an `evidencePolicy`: a pure, synchronous check that can admit a non-owner resolver class on the evidence its resolve carries, and only then. `resolve` takes an optional fourth `evidence` argument, a JSON object of at most 16 KB, stored on the row as `resolvedEvidence` so an audit can re-check the decision. The policy runs where allowances do, before the gate's rule and `authorize`; a throw or any answer but `true` refuses. `SqliteGateStore` keeps the evidence in a `resolved_evidence` column added by the new `gateEvidenceMigration`, and refuses an evidence resolve on a table without it. `GateEvidenceInvalid` names evidence that is not a JSON object or is too large.

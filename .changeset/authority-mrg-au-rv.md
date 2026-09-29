---
"@titan-design/authority": minor
---

Add row MRG-AU-RV (owner decision D-A): an automation merge is allowed when the run-dispatched reviewer's MERGE verdict names the exact head, every required context is green at that head from an allowed app, no run from those apps is non-green, the merge-tree is clean, the repo is not frozen, no `.github/workflows` or `.github/actions` path changes, and the seat grants `merge-on-green-approve`. Otherwise MRG-AU still gates. Rules gain an optional `when` list of `CONDITION_KINDS`, checked against the new `AuthorityRequest.facts`; conditional rows are allow-only and do not count toward totality. Adds `unmetConditions`, the `MergeFacts` types and the evidence kind `E-rev`.

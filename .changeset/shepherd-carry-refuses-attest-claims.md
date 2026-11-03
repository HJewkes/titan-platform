---
"@titan-design/factory": patch
---

Shepherd no longer carries a MERGE to a head that claims `attestations.json` rows. A new `sh-carry-claims` step reads the claims the same way the attestation judge does, and the carry goes ahead only when the head claims none. Otherwise the run asks for a fresh review at that head, and the reviewer's brief lists the claimed rows. Before this, the carried verdict reached the judge and gated the owner with "attestation unmet: carried". An unreadable file does not carry. A head that claims no rows carries as before.

---
"@titan-design/factory": patch
---

Shepherd's sh-merge-evidence step no longer fails the run when the attestation judge's roster or lineage read stays timed out past the session-start window. The step already holds a MERGE verdict, so it now reads the roster again after a doubling pause (1 min, up to 8 min) until the broker answers.

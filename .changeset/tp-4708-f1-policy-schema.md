---
"@titan-design/factory": patch
---

Move the effective-policy type and schema, the merge-mode and owner-gate-reason lists, `RegistrationRefused`, `stricterPolicy`, `repeatedPolicy` and the visual-baseline types into a `policy-schema.ts` leaf, so the Shepherd store no longer imports policy.ts's land code, and lower the import-cycle ceiling. A pure move; no behaviour change.

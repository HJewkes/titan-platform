---
"@titan-design/factory": patch
---

Shepherd's `merge:auto` seat now allows a merge only when authority's `MRG-AU-RV` holds on merge facts collected at the exact head. A new `sh-merge-evidence` step collects the facts and posts one evidence comment per head. Any `.github/` path, including a rename source, still gates. `shepherdLandOptions` hands the evidence record to `allowEvidence`.

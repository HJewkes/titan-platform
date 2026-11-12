---
"@titan-design/factory": patch
---

ci-wait settles a required fix-proof job on the release PR (`changeset-release/main` from the base repo), where the fix-proof workflow skips every job, instead of waiting until it times out. Any other head, or a release head where a fix-proof job ran or was cancelled, is judged as before. ci-wait and merge bump their step versions.

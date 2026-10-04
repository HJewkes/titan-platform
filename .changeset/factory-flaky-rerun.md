---
"@titan-design/factory": patch
---

Add `shepherd.flakyChecks`, a per-repo list of required-check names and a wait in seconds. When every failed required check is on the repo's list, `ci-wait` reruns the failed jobs once per head after the wait, before any wake; an unlisted failure, or a second red after the rerun, wakes as before.

The flaky rerun re-reads the head and run after its wait and skips a moved or replaced run, spends its budget only when GitHub accepts the rerun, and `waitSeconds` is capped at 900.

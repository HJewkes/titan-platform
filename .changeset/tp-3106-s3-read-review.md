---
"@titan-design/factory": patch
---

TP-3106 S3: the registry's READ rows for core, build-surface and audit steps are reviewed. Nine pure reads and waits (`update-backoff`, `base-wait`, `merge-settle`, `await-new-head`, `snapshot`, `bs-plan`, `bs-await-land`, `audit-load`, `audit-inventory-data`) become `read`, so a restart whose replay diverged before one of them drops its orphan and the run continues instead of parking. Eight steps that run a repo-configured command keep parking, each naming the command as its reason.

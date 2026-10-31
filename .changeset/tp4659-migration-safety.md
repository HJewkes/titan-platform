---
"@titan-design/active-work": patch
---

The v3-to-v4 migration now leaves an `artifacts.yml` it cannot parse untouched, keeps that initiative's brief as it was, and records the skip in `.migrations.log`. The v1-to-v2 migration skips null list elements instead of throwing.

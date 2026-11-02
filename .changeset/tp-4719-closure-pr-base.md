---
---

`pnpm registry:closure` now compares attestation rows against the pull request's base branch (`GITHUB_BASE_REF`) when no base is given, so a stacked pull request is not failed for its parent's row. Scripts only; no package changes.

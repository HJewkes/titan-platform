---
"@titan-design/factory": patch
---

The toolchain sweep's `openAdoption` now refuses a leftover adoption branch. When `ensureBranch` reports the branch already existed, it throws `<repo>: leftover branch <branch> already exists; refusing to adopt over it` before any file write or PR open, the sweep notes it as that repo's error, and the other repos still run.

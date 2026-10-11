---
"@titan-design/factory": patch
---

Merge a Version Packages pull request only for a seat whose grants include `release-merge`. A seat with `merge-on-green-approve` alone now gates the release as `shepherd-release/no-release-grant`, because that merge publishes to npm.

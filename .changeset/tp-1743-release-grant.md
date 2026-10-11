---
"@titan-design/factory": patch
---

Merge a Version Packages pull request only for a seat whose grants include `release-merge`. A seat with `merge-on-green-approve` alone now gates the release as `shepherd-release/no-release-grant`, because that merge publishes to npm. A seat without the grant no longer freezes the repo's other merges while its release waits.

The release preflight also needs each package's latest npm version to name a trusted publisher (`_npmUser.trustedPublisher` with an `id`); provenance attestations alone do not count. A hand-published latest version blocks the release for the owner, because release.yml cannot publish without one. Registry reads now time out after 10 seconds.

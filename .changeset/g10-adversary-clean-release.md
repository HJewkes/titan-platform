---
"@titan-design/factory": minor
---

Shepherd: under `shepherd.gateReset.twoMergeRelease: on`, a `g10-adversary` hold now releases itself on the adversary member's clean verdict at the PR's head: a MERGE whose `Authority:` line reads `unchanged` or `tightened`, with required CI green and no change to the owner's rule file. The correctness MERGE and the lineage check are no longer read for the hold; a FIX_FIRST, a `widened` line or a missing line keeps the hold for the owner. A panel that withholds its verdict still records the adversary's MERGE so it can release the hold. The release event's actor is `shepherd:verdict:<agentId>/<sessionId>`, and a `g10-review` hold the release uncovers is judged at once on the opus MERGE in hand. A changesets Version Packages PR on `changeset-release/main` whose diff is version-only (release files only, manifests changing only versions and bumped ranges) takes no G10 touch hold.

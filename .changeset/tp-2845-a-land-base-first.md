---
"@titan-design/factory": patch
---

Land checks the PR's base before the merge decision. A PR whose base is not the default branch (and whose run may not merge into a feature base) now waits at `base-wait` with no `merge-policy` step and no approve-merge gate; after a retarget it re-reads the rules and decides on the new base. Merge evidence read on another base is re-read before the decision (`LandOptions.evidenceBase`). Runs recorded before this replay without the new check.

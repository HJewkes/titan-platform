---
"@titan-design/factory": patch
---

factory: with `shepherd.gateReset.twoMergeRelease` set to `on`, a run held `g10-adversary:` releases with no seat when Shepherd's opus correctness MERGE and its adversary member's MERGE stand at the PR's current head, written there or carried by a recorded clean merge-up, with required CI green. The two must come from different sessions and different profiles. The hold stays if it names a reviewer, if the diff touches `packages/authority/src/table.json` (rename sources included), or if the file list cannot be read whole. The `sh-g10-release` step records the rule `g10-adversary/two-merge` and both verdict refs and profiles. The release event carries the head, so later heads must stay on its clean merge-up line. Under `shadow` the step records `wouldRelease` and releases nothing. A panel MERGE now records each member's verdict, head and spawn profile.

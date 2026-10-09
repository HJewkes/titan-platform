---
"@titan-design/factory": minor
---

`titan-factory gate resolve` from an agent-chat shell resolves as the coordinator, with no presence dialog, for three gate classes the owner let through on 2026-10-07 (TP-1904): an approve-merge at a head a reviewer said MERGE at, under an `authority/MRG-AU` decision whose recorded reason names only mechanical unmet conditions (reviewer verdict, required checks, merge tree) and an `auto` seat, with the base's required checks green at that head and the PR mergeable; a main-red acknowledgement or main-frozen unfreeze once the base's green tip contains the merge; and an abandon of a PR gate whose PR is merged or closed. The command reads the evidence fresh through the GitHub port, the gate store re-checks it with `coordinatorEvidencePolicy` and stores it on the gate as `resolvedEvidence`. Any failed or partial read falls back to the presence dialog. The factory database gains `gateEvidenceMigration` as version 14.

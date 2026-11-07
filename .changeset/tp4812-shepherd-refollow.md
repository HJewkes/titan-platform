---
"@titan-design/factory": minor
---

A new verb, `titan-factory shepherd refollow [--repo owner/repo] [--dry-run]`, asks a pending land gate again so the run's approval carry decides it (TP-4812, TP-4791 S2). It cancels a land `approve-merge` gate with a reason that starts `superseded: refollow: `, and only when all of these hold: the gate is at the PR's open head, read fresh; the run is registered with no owner hold; an earlier land gate of the run was answered `merge` by an owner class (`owner-terminal` or `owner-remote`); and no refollow has cancelled a gate at that head before. The cancel is a plain supersede, so the head keeps its review. The run asks again at the same head, where `followingApprovals` either records the follow or opens the owner's gate again. The coordinator never supplies an answer, and no evidence kind is added.

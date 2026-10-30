---
"@titan-design/factory": minor
---

Autoresearch targets can opt into snapshot PRs with a `snapshot` block (`repo`, `task`, `implementer`, `reviewer?`, `logDir`). Such a target's runs get the cadence settings, and its ports cut the snapshot, open its PR and register it with Shepherd through the in-process `shepherd.register` (kind `feature`). They also sync main back into the ratchet. A host with a snapshot target but no Shepherd services refuses to start with `[no-shepherd]`. A sync that moves the ratchet is recorded as an `autoresearch.ratchet` move of kind `sync`. A `resolved` gate answer is refused with `[sync-frozen]` when it changes a frozen path the gate did not show. A snapshot retried after its push landed converges onto the pushed refs only when the remote tag already names the same sha. L0 puts the tree back at the head it checked when a target's proof moved HEAD.

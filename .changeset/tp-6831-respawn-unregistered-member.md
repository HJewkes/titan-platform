---
"@titan-design/factory": patch
---

Re-spawn a panel member once when its spawn was admitted but its agent never registered (TP-6831). Two shapes count: the ask went through and no session showed by the start deadline (`sh-review` now marks that `unseen`), or the verdict wait ended on an agent no roster read ever listed and whose transcript stayed empty (`sh-await-verdict` now marks that `unregistered`). The member is spawned once more under the next name in its series, at `sh-review:<head>:<shape>:respawn`. If it still never registers, the round reads `not-started` and retries without counting a failed round, under the existing `MAX_NOT_STARTED_REVIEWS` bound. Before, both shapes ended as "a blocking panel member gave no verdict" and counted toward the dead-end. A member that registered and then said nothing still counts no-verdict, and the dead-end and owner-gate rules are unchanged.

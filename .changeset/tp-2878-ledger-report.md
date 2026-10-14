---
"@titan-design/dispatch-ledger": patch
---

Re-port the ledger schema and release semantics from agent-chat `67005f3` (TP-2878): `STALL_CODES` gains `no-repo` (parked as `failed`); `StackedOn.forkHead`, `Claim.reregistered`, `Claim.overlapsAccepted` (with `AcceptedOverlapSchema`), `LadderRecord.reason`, `Ledger.dailyRetire` and `Ledger.slicesFlagged` join the schema; a release's `code` is optional beside a new `reason`, the released ladder record drops the old `code` and `reason`, and a requeue keeps `overlapsAccepted`.

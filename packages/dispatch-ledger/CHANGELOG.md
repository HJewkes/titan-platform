# @titan-design/dispatch-ledger

## 0.1.1

### Patch Changes

- Updated dependencies [c58d555]
- Updated dependencies [c1f9297]
  - @titan-design/store-sqlite@0.5.0

## 0.1.0

### Minor Changes

- e13fa62: Add the pure ledger operations (TP-2578 b): `heldClaims`, `laneClaims`, `ledgerImplementers`, `slotMismatch`, `isStalled`, `sameClaim`, `addClaim`, `readySlices`, `claimKey`, `applyActions` over a narrowed `LedgerAction`, and `firstCode` and `parkUpdate`.
- cbe86d1: Add the ledger store (TP-2578 c): the `LedgerStore` interface with `memoryLedgerStore` and a `SqliteLedgerStore` on `dispatchLedgerDdl()` tables, whose writes check a revision (`StaleRevisionError`) and the phase edges, plus `importLedgerJson` and `normalizeLedger`.
- 7499621: Add the burndown claim ledger package (TP-2578 a): the zod `LedgerSchema` and `ClaimSchema` with their vocabularies, the claim-phase edge table, and a byte-preserving `burndown.json` parse and export.

### Patch Changes

- 87e7b2a: `SqliteLedgerStore.read` throws `LedgerMalformedError` for a meta doc or claim row that is not JSON, an invalid meta row, and claim rows with no meta row, instead of a raw error or an empty ledger. The README names the storage, write guard and malformed behaviour of every ledger section.
- 373bfc9: Add owed-holds storage (CC-931): `OwedHoldSchema`, the `OwedHoldStore` interface with `memoryOwedHoldStore` and `SqliteOwedHoldStore`, the `dispatch_owed_hold` table from `dispatchOwedHoldsDdl` / `dispatchOwedHoldsMigration`, and `parseOwedHoldsJson` / `exportOwedHoldsJson` for agent-chat's `burndown-owed-holds.json`.
- 7783748: Re-port the ledger schema and release semantics from agent-chat `67005f3` (TP-2878): `STALL_CODES` gains `no-repo` (parked as `failed`); `StackedOn.forkHead`, `Claim.reregistered`, `Claim.overlapsAccepted` (with `AcceptedOverlapSchema`), `LadderRecord.reason`, `Ledger.dailyRetire` and `Ledger.slicesFlagged` join the schema; a release's `code` is optional beside a new `reason`, the released ladder record drops the old `code` and `reason`, and a requeue keeps `overlapsAccepted`.

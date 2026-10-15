# @titan-design/dispatch-ledger

The burndown claim ledger as a library: the zod schema, its closed vocabularies, the
claim-phase transition table, and a `burndown.json` parse and export that keeps the file's
bytes.

Tier 2 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Ported from agent-chat `src/agents/burndown` at commit `67005f3`. Re-port anything that
lands there before the agent-chat copy is deleted.

## Schema and vocabularies

`LedgerSchema` and `ClaimSchema` validate a ledger and one claim; their inferred types are
`Ledger` and `Claim`. `PHASES`, `AGENT_PHASES`, `STALL_CODES`, `LADDER_CODES`,
`STALE_CLASSES`, `EXCEPTION_CLASSES`, `CONTRACT_OPS` and `DESTRUCTIVE_OPS` are the closed
sets the schema uses. `PHASE_TIMEOUT_MS` gives each agent phase its timeout, and
`EMPTY_LEDGER` is the ledger of a missing file.

## Phase edges

`PHASE_EDGES` lists every phase change a claim may take. `illegalEdges(before, after)`
returns the changes outside it, pairing claims by `taskId#slice` and then by position.
`illegalEdgeError` returns the `IllegalPhaseEdgeError` a write should throw for the first
one, or `undefined`. Neither logs.

## Pure ledger operations

Queries over a `Ledger`, none of which reads a file or the clock:

- `heldClaims` (every claim short of `done`), `laneClaims` (claims with an agent at work) and
  `ledgerImplementers(ledger, seat)`;
- `slotMismatch(ledger, live)`, the flag for a count more than `SLOT_MISMATCH_TOLERANCE` (3) ahead
  of its live agents;
- `isStalled(claim, now)`: a stall reason, or past the phase's `PHASE_TIMEOUT_MS`;
- `readySlices(ledger, held?, stack?)`: queued slices whose dependencies are done or in
  `slicesReleased`, with an optional `StackPredicate` that admits one unmet dependency;
- `claimKey`, `sameClaim` and `addClaim`, which refuses a second claim on a held `(task, slice)`.

`applyActions(ledger, actions, now)` folds a tick's actions into the next ledger. It reads the
`update`, `add`, `ladder`, `brake` and `release` kinds and passes `spawn`, `retire` and `register`
through, so a product's own action union, whose side-effect kinds carry product types, is
assignable to `LedgerAction`. A phase change or a new agent restarts `phaseAt`; a new stall stamps
`stalledAt` once. `firstCode` picks the stall code of highest precedence, and `parkUpdate` builds
the `update` that parks a claim under its code's exception class.

## JSON parse and export

```ts
import { exportLedgerJson, parseLedgerJson, writeLedgerExport } from "@titan-design/dispatch-ledger";

const ledger = parseLedgerJson(text); // throws LedgerMalformedError
exportLedgerJson(ledger) === text; // true for a file this package or agent-chat wrote
writeLedgerExport("/path/to/burndown.json", ledger); // temp file, rename, mode 0600
```

`parseLedgerJson` validates with zod but returns the raw parsed JSON, so key order and
keys the schema does not name survive the round trip.

## Ledger store

```ts
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { SqliteLedgerStore, dispatchLedgerMigration, importLedgerJson } from "@titan-design/dispatch-ledger";

runMigrations(db, [dispatchLedgerMigration(7)]); // or db.exec(dispatchLedgerDdl())
const store = new SqliteLedgerStore(db);
importLedgerJson(store, text);
const { ledger, revision } = store.read();
store.write(next, revision); // StaleRevisionError if another writer got there first
```

`LedgerStore` is `read()` and `write(next, expectedRevision?)`. A write refuses a stale
revision (`StaleRevisionError`), a claim phase change outside `PHASE_EDGES` against the
stored claims (`IllegalPhaseEdgeError`) and a ledger the schema refuses
(`LedgerMalformedError`), and changes nothing when it refuses. Every write bumps the
revision; an empty store reads `EMPTY_LEDGER` at revision 0.

A write stores `normalizeLedger(next)`: zod's output, so keys the schema does not name are
dropped and contract scopes trimmed, but laid out in the input's key order. A ledger that is
already normalized, such as a `burndown.json` agent-chat wrote, exports back to the same
bytes.

`SqliteLedgerStore` writes in one immediate transaction on the two tables of
`dispatchLedgerDdl()`: `dispatch_claim`, one row per claim by `ordinal` with its JSON and
`task_id`, `slice`, `phase`, `seat` and `agent_name` columns, and the single-row
`dispatch_ledger_meta`, holding the revision, `lastTickAt`, and the rest of the ledger with
`claims: []` in place. The product mounts the DDL in its own database.
`memoryLedgerStore(initial?)` keeps the ledger in process for tests and dry runs. Both hand
out copies.

### Storage

Every `Ledger` section, where `SqliteLedgerStore` keeps it, the guards a write passes before
it is stored, and what a malformed stored value does. The doc is written whole, with every
section, in the same transaction as the claim rows and the revision bump.

| Section | Table and column | Write guard | Malformed |
|---|---|---|---|
| `version` | `dispatch_ledger_meta.doc` key | revision, schema | read throws |
| `lastTickAt` | `dispatch_ledger_meta.doc` key, copied to `last_tick_at` | revision, schema | read throws |
| `claims` | `dispatch_claim` rows by `ordinal`: `claim` JSON plus index columns; `[]` in the doc | revision, phase edges, schema | read throws, naming the ordinal |
| `decider` | `dispatch_ledger_meta.doc` key | revision, schema | read throws |
| `seats` | `dispatch_ledger_meta.doc` key | revision, schema | read throws |
| `dailyRetire` | `dispatch_ledger_meta.doc` key | revision, schema | read throws |
| `humanFiled` | `dispatch_ledger_meta.doc` key | revision, schema | read throws |
| `leakScanner` | `dispatch_ledger_meta.doc` key | revision, schema | read throws |
| `leakScans` | `dispatch_ledger_meta.doc` key | revision, schema | read throws |
| `releases` | `dispatch_ledger_meta.doc` key | revision, schema | read throws |
| `slicesReleased` | `dispatch_ledger_meta.doc` key | revision, schema | read throws |
| `slicesFlagged` | `dispatch_ledger_meta.doc` key | revision, schema | read throws |
| `triageStarts` | `dispatch_ledger_meta.doc` key | revision, schema | read throws |
| `liveness` | `dispatch_ledger_meta.doc` key | revision, schema | read throws |
| `ladder` | `dispatch_ledger_meta.doc` key | revision, schema | read throws |
| `brake` | `dispatch_ledger_meta.doc` key | revision, schema | read throws |
| `serviceCheck` | `dispatch_ledger_meta.doc` key | revision, schema | read throws |
| `wake` | `dispatch_ledger_meta.doc` key | revision, schema | read throws |
| owed holds (not a `Ledger` section) | `dispatch_owed_hold` rows by `ordinal`, keyed by `repo` and `pr` | schema only, outside the revision | read throws, naming the position |

The guards are the revision check (`StaleRevisionError`), the phase edges against the stored
claims (`IllegalPhaseEdgeError`, claims only) and the schema (`LedgerMalformedError`).
"Read throws" means `read()`, and so any `write()`, throws `LedgerMalformedError` and changes
nothing: a meta doc or claim row that is not JSON, a meta row whose revision is not an
integer, a doc plus claims the schema refuses, and claim rows with no meta row. Only a store
with no rows in either table reads as `EMPTY_LEDGER`; guessing empty over orphaned claims
would dispatch them twice. Error messages never carry stored text.

## Owed holds

```ts
import {
  SqliteOwedHoldStore,
  dispatchOwedHoldsMigration,
  exportOwedHoldsJson,
  parseOwedHoldsJson,
} from "@titan-design/dispatch-ledger";

runMigrations(db, [dispatchLedgerMigration(7), dispatchOwedHoldsMigration(8)]);
const holds = new SqliteOwedHoldStore(db);
holds.write(parseOwedHoldsJson(text)); // agent-chat's burndown-owed-holds.json
exportOwedHoldsJson(holds.read()) === text; // true for a file agent-chat wrote
```

An owed hold (CC-931) is a Shepherd hold a tick owes on a run it registered and then failed
to hold. `OwedHoldSchema` is `{ seat, repo, pr, reason }`, ported from agent-chat
`src/agents/burndown/owed-holds.ts`. Owed holds are not a `Ledger` section: `OwedHoldStore`
writes at once, outside the ledger revision and any lease fence, so a hold owed by a tick that
dies before it commits survives, and one bad hold never makes the ledger unreadable.

`OwedHoldStore` is `read()` and `write(holds)`. A write replaces the whole set in order,
keeping one hold per repo and PR: a later hold replaces an earlier one in the earlier one's
place. It refuses a hold the schema refuses with `LedgerMalformedError` and changes nothing.
An empty store reads `[]`. `SqliteOwedHoldStore` writes in one immediate transaction on the
`dispatch_owed_hold` table of `dispatchOwedHoldsDdl()` and refuses a stored row the schema
refuses with `LedgerMalformedError`. `memoryOwedHoldStore(initial?)` keeps the set in process.

`parseOwedHoldsJson(text)` reads like agent-chat's `readOwedHolds`: missing (`undefined`),
non-JSON or non-array text owes nothing, and a malformed entry is dropped while the rest are
kept. `exportOwedHoldsJson(holds)` is `JSON.stringify(holds, null, 2)` plus a newline, the
bytes agent-chat writes.

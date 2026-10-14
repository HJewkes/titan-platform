# @titan-design/dispatch-ledger

The burndown claim ledger as a library: the zod schema, its closed vocabularies, the
claim-phase transition table, and a `burndown.json` parse and export that keeps the file's
bytes.

Tier 2 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Ported from agent-chat `src/agents/burndown` at commit `1a717cb`. Re-port anything that
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

## JSON parse and export

```ts
import { exportLedgerJson, parseLedgerJson, writeLedgerExport } from "@titan-design/dispatch-ledger";

const ledger = parseLedgerJson(text); // throws LedgerMalformedError
exportLedgerJson(ledger) === text; // true for a file this package or agent-chat wrote
writeLedgerExport("/path/to/burndown.json", ledger); // temp file, rename, mode 0600
```

`parseLedgerJson` validates with zod but returns the raw parsed JSON, so key order and
keys the schema does not name survive the round trip.

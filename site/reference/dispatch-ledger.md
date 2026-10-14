# dispatch-ledger

**Tier 2.** No titan dependencies yet.

```sh
npm install @titan-design/dispatch-ledger
```

## The problem it solves

The burndown dispatcher keeps its claim ledger (which task each spawned agent holds, in
which phase, and why it stalled) as one JSON file inside a product. Anything else that
wanted to read or validate that ledger had to copy the product's schema. This package holds
the ledger's zod schema, its closed vocabularies and its claim-phase transition table, so a
dispatcher, a store and a thin CLI client all validate against one definition.

## When to reach for it

- Validating a `burndown.json` ledger, or a single claim, before acting on it: `LedgerSchema`
  and `ClaimSchema`.
- Refusing a ledger write that moves a claim along an edge the dispatcher never emits:
  `illegalEdges` and `illegalEdgeError`.
- Reading and exporting `burndown.json` without disturbing its bytes: `parseLedgerJson`,
  `exportLedgerJson` and `writeLedgerExport`.
- Answering ledger questions without re-deriving them: which claims hold a lane
  (`laneClaims`), which slices are ready to dispatch (`readySlices`), whether a claim stalled
  (`isStalled`), and folding a tick's actions into the next ledger (`applyActions`).

For the seat config and charter a coordinator reads, use
[`coordinator`](/reference/coordinator). For agent execution state with fenced ownership,
use [`agent-lifecycle`](/reference/agent-lifecycle).

## Example

Verified against the workspace build that ships as 0.1.0.

```ts
import { exportLedgerJson, illegalEdgeError, parseLedgerJson } from "@titan-design/dispatch-ledger";

const before = parseLedgerJson(previousText);
const next = parseLedgerJson(nextText);
const refused = illegalEdgeError(before.claims, next.claims);
if (refused) throw refused;
const bytes = exportLedgerJson(next);
```

## What it deliberately does not do

It does not lock the ledger, run the dispatcher tick, or talk to the broker. It reads no
file except through `writeLedgerExport`, which only writes. The phase-edge check never
logs: it returns the edges or an error, and the caller logs.

## Gotchas

- `parseLedgerJson` validates with zod but returns the raw parsed JSON, not zod's output.
  zod emits keys in schema order and drops unknown ones, so only the raw value exports back
  to the same bytes. Treat any key the schema does not name as opaque.
- `illegalEdges` pairs claims by `taskId#slice` and then by position, so a released claim
  that drops the newest entry of a key is not read as an edge.
- `applyActions` passes `spawn`, `retire` and `register` through without reading them. A
  product widens `LedgerAction` with its own payloads; it never needs this package to know
  them.
- A claim that keeps its phase is never an edge, and a claim with no earlier counterpart is
  never held to one.

## Where it came from

Ported from agent-chat's burndown ledger at commit `1a717cb` as the first slice of moving
the ledger into the factory's sqlite database. The agent-chat copy is deleted once the
factory consumes this package.

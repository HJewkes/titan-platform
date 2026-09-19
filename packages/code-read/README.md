# @titan-design/code-read

A versioned read API over `@titan-design/code-graph` snapshots, for three kinds of consumer:
a drill-down report UI (live or from a static export), agents over MCP, and workflows. The
package holds one contract, one per-snapshot `ReadModel`, and one pure query function per
command. The daemon's commands and a browser's static dataset both answer through those
functions.

Tier 2 of the titan-platform DAG (TP-184). Depends on `code-graph`, `registry`, and
`rpc-protocol`; `zod` is a peer.

## Two entry points

| Import | Runs in | Holds |
| --- | --- | --- |
| `@titan-design/code-read/query` | browser or Node | the contract (`CONTRACT`, `CODE_READ_API_VERSION`, zod schemas), `ReadModel` and `buildReadModel`, the `ReadSource` seam, `QUERIES`, `createQueryResolver` |
| `@titan-design/code-read` | Node | everything in `./query`, plus `loadReadModel`, `createLiveSource` (SQLite plus an LRU of models), and `registerCodeReadCommands` |

`./query` imports only its own files, `zod`, and `rpc-protocol`. Three rules in
`.codewatch/check.json` (`code-read-query-*`) and `src/browser-safe.test.ts` enforce that.
The test bundles the subpath with esbuild for `platform: "browser"` and expects no warnings.

## Commands (contract 0.1.1)

| Command | Args | Result |
| --- | --- | --- |
| `api.describe` | none | `api`, `dataset`, `commands`, `newest`, `indexVersions`, `capabilities`, `metrics` (catalogue descriptors with provenance), `rules` |
| `snapshot.list` | `ref?`, `limit` (1 to 500, default 50) | `snapshots`, newest first |
| `hierarchy.get` | `snapshot?`, `root?`, `depth` (1 to 8, default 2), `metrics` (default `["loc"]`), `baseline?`, `include_symbols`, `exclude_roles` | `snapshotId`, `baselineSnapshotId?`, `comparable?`, `nodes` (flat, shallowest first, with `parentId`, `depth`, `childCount`, `values`, `missing?`, `deltas?`), `truncated` |
| `node.get` | `snapshot?`, `id`, `baseline?`, `metrics` (default: every one that applies) | `node`, `ancestors` (repo first), `childCounts`, `metrics` (value, `direction`, `rollup`, `percentile`, `siblingMedian`, `siblingRank`, `siblingCount`, `baseline?`, `delta?`, `missing?`) |
| `node.resolve` | exactly one of `query` or `path`, plus `line?` with `path`, `limit` (1 to 50, default 10) | `candidates`: `node`, `score`, `match` |

Arguments are snake_case and results are camelCase. `snapshot` and `baseline` take an id, a
digit string, or a ref name (that ref's newest snapshot). The rest of the design's 14
commands arrive in later minor versions of the contract.

## The hierarchy

code-graph stores files and symbols only, so `./query` synthesizes the rest per snapshot:

- **Ids.** The repo is `""`. A directory is its path plus `/`, such as `src/util/`; no file id
  ends in `/`. Module and external nodes are not in the hierarchy.
- **Class level.** A symbol named `Job.run` hangs under `Job` when that symbol exists, else
  under the nearest existing scope. A bare name (snapshots before code-graph 0.14.0) hangs
  under the smallest symbol whose span encloses it, else under its file.
- **Rollups.** A directory's value, or a file's value for a symbol-only metric, combines the
  stored values below it by the catalogue's `rollup` rule: `sum`, `max`, or `mean`. A file
  metric rolls up from files only, so nothing counts twice. `absent: "zero"` counts a
  missing row as 0; `absent: "exclude"` leaves it out.
- **Why a value is null.** `missing` says why: `no-rollup` (the rule is `none`, as for commit
  and author counts, bus factor, and fan-in; directory-level history is TP-233),
  `not-measured`, `not-applicable` (such as `loc` on a symbol), or `not-in-snapshot`.
- **Roles.** `exclude_roles` drops files of those roles from the rows, the rollups, and the
  baseline alike.
- **Deltas.** Baseline nodes match by id only; alias following is TP-187. `comparable` is
  false when the two snapshots have different index versions.
- **Size.** `hierarchy.get` returns at most `HIERARCHY_ROW_CAP` (5,000) rows breadth-first
  and sets `truncated`. `childCount` always counts every child, symbols included.

`node.get` percentiles are the share of same-kind nodes whose value is at most the node's,
0 to 100. Siblings are the same-kind children of the same parent, the node included; rank 1
is the largest value. Neither number knows which way is worse. Read `direction` on the same
metric before labelling anything "top" or "best".

Worked example. A file with `loc: 3` among sibling files with 0, 1, 2, and 2 lines gets
`siblingRank: 1`, and 7 of the snapshot's 10 files have at most 3 lines, so `percentile: 70`.
`loc` is `direction: "higher-worse"`, so rank 1 is the file with the most lines. It is the
worst offender in its directory, not the best file. For `bus_factor_30d`
(`direction: "lower-worse"`), rank 1 is the file with the most authors covering its churn,
which is the safest file. For a `neutral` metric such as `churn_30d`, rank 1 only means
"largest".

`node.resolve` ports codewatch's `rankSearch` cascade over directories, files, and symbols,
case-insensitive: exact id or name 100, id suffix after `/` or `#` 80, name prefix 60, id
substring 40, name substring 30, ties by id. One addition for qualified names: a symbol whose
last segment equals the query, such as `run` for `Task.run`, scores as a suffix. A `path`
with a `line`, or a `query` of the form `path:line`, maps each matching file to the innermost
symbol whose span holds the line.

## Serving the commands

```ts
import { openCodeGraph, loadCheckRules } from "@titan-design/code-graph";
import { registerCodeReadCommands } from "@titan-design/code-read";
import { startDaemon } from "@titan-design/daemon";
import { createRegistry } from "@titan-design/registry";

const registry = createRegistry();
const rules = await loadCheckRules(".codewatch/check.json");
registerCodeReadCommands(registry, { openStore: () => openCodeGraph(".codewatch/graph.db"), rules: () => rules });
await startDaemon({ registry, createContext: () => ({ warnings: [], format: "json" }), version, stateDir, toolPrefix: "codewatch__" });
```

The daemon then answers `POST /rpc/api.describe` and the MCP tool `codewatch__api__describe`
with the same envelope as an in-process `invokeCommand`. The daemon lists every registered
command as a tool. To follow the design and put only the agent-shaped commands on MCP,
register only the `defineCodeReadCommands(source)` entries whose names are in
`AGENT_COMMANDS` on the registry that serves MCP.

## Answering without a daemon

`createQueryResolver(source)` returns `(name, args) => JsonEnvelope`. It validates raw args
against the contract, runs the query, and never throws. It uses the same codes as the
daemon: `DATAERR` for bad args, `NOINPUT` for a missing snapshot, `UNAVAILABLE` for a command
the source does not serve, and `USAGE` for an unknown name. The resolver fits
`@titan-design/rpc-client`'s static `resolve` option. Any `ReadSource` works, for example
one decoded from a static dataset.

## Versioning

`CODE_READ_API_VERSION` is the contract's semver. `contract.lock.json` stores every
command's args and result as JSON Schema. `src/contract-lock.test.ts` fails when the schemas
change and the version does not. Its failure message says whether the change is breaking
and names each breaking path. After bumping, regenerate the lock:

```sh
UPDATE_CONTRACT_LOCK=1 pnpm vitest run packages/code-read/src/contract-lock.test.ts
```

The lock leaves out descriptions, so a documentation edit needs no bump.

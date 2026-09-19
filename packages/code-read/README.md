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

## Commands (contract 0.1.0)

| Command | Args | Result |
| --- | --- | --- |
| `api.describe` | none | `api`, `dataset`, `commands`, `newest`, `indexVersions`, `capabilities`, `metrics` (catalogue descriptors with provenance), `rules` |
| `snapshot.list` | `ref?`, `limit` (1 to 500, default 50) | `snapshots`, newest first |

Arguments are snake_case and results are camelCase. The rest of the design's 14 commands
arrive in later minor versions of the contract.

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
with the same envelope as an in-process `invokeCommand`.

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

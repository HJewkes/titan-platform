# @titan-design/rpc-client

A browser-safe typed client for a titan daemon. The same front-end code runs against a
running daemon (`liveSource`: `POST /rpc/<name>` plus the `/events` SSE stream) or against
one exported JSON file with no server at all (`staticSource` over a `titan-snapshot@1`).

Tier 1 of the titan-platform DAG (TP-139). Its only dependency is
`@titan-design/rpc-protocol`; no zod, no registry, no Node imports in the main entry.
`src/browser-safe.test.ts` and the `rpc-client-browser-no-node` rule in
`.codewatch/check.json` enforce that. The `./node` entry holds `exportSnapshot`, which writes
the file.

```ts
import type { CommandMapOf } from "@titan-design/registry"; // erased at build
import { createRpcClient, liveSource, parseSnapshot, staticSource } from "@titan-design/rpc-client";
import type { commands } from "../server/commands.js"; // { "task.list": taskList, ... }

type Commands = CommandMapOf<typeof commands>;

const source = window.__SNAPSHOT__
  ? staticSource({ snapshot: parseSnapshot(window.__SNAPSHOT__) })
  : liveSource(); // same origin as the page
const client = createRpcClient<Commands>(source);

const { slugs } = await client.call("task.list", { status: "open" }); // typed args and result
client.subscribe({ onEvent: (m) => m.event === "change" && refetch() });
```

## Exports

| Export | What it does |
| --- | --- |
| `createRpcClient<M>(source)` | `call(name, args?, { signal })` typed by `M`; rejects with `RpcError` (`command`, `code`, `message`) on a failure envelope. Args may be omitted only when every field is optional. |
| `liveSource({ origin?, fetch?, reconnectDelayMs?, maxReconnectDelayMs? })` | Calls with a JSON content type and `x-titan-client: rpc-client`, so the daemon's guards pass from a page or from Node. SSE over `fetch`, redialled with doubling backoff (500 ms to 10 s) until closed. |
| `staticSource({ snapshot, resolve? })` | Recorded answer by canonical key first, then `resolve(command, args, snapshot.dataset)`, then `EXIT.UNAVAILABLE`. A resolver that throws, rejects, or returns no envelope answers `EXIT.SOFTWARE` with its message. Returns a fresh copy per call. |
| `DataSource` | `call(name, args, { signal })` resolves to an envelope for every outcome and rejects only on abort; `subscribe(handlers, { signal })`. Args must be JSON-serialisable: a BigInt or a cycle answers `EXIT.DATAERR` from both sources. |
| `Snapshot`, `SNAPSHOT_FORMAT`, `parseSnapshot`, `buildSnapshot` | The `titan-snapshot@1` container, its validator, and a recorder over any source. |
| `SnapshotResolver<D>` | `(command, args, dataset) => JsonEnvelope \| Promise<JsonEnvelope>`; never throws. |
| `snapshotKey`, `canonicalArgs`, `wireArgs` | The canonical lookup key and the JSON-normalised args it is computed from. |
| `exportSnapshot(file, source, plan)` from `./node` | Answers every planned call through `source` and writes the file. |

## `titan-snapshot@1`

```json
{
  "format": "titan-snapshot@1",
  "createdAt": "2026-09-18T12:00:00.000Z",
  "calls": { "[\"task.list\",{\"status\":\"open\"}]": { "ok": true, "data": { "slugs": ["a"] } } },
  "dataset": "optional, opaque here; shaped by whichever package supplies the resolver"
}
```

The key is `snapshotKey(command, args)`: the args as a daemon would receive them (JSON
round-tripped; no args, `null`, and `{}` are the same), with every object's keys sorted.
Failure envelopes are recorded too, so a replay fails the same way the daemon did.

To export from a registry in process, pass a caller that wraps `invokeCommand`:

```ts
import { exportSnapshot } from "@titan-design/rpc-client/node";

await exportSnapshot("report/snapshot.json", {
  call: async (name, args) => {
    const cmd = registry.get(name);
    if (!cmd) return errorEnvelope(`Unknown command: ${name}`, EXIT.USAGE);
    return (await invokeCommand(cmd, args, createContext("export"), { invalidArgsCode: EXIT.DATAERR })).envelope;
  },
}, { calls: [{ command: "task.list", args: { status: "open" } }], dataset });
```

A `liveSource` works as the source too, which exports from a running daemon.

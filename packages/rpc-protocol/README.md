# @titan-design/rpc-protocol

The wire contract between a titan daemon and any client of it: the JSON envelope every
command returns, the `EXIT` codes inside it, the HTTP routes, the statuses `POST /rpc/:name`
answers with, the SSE vocabulary on `/events`, and the `CommandMap` type a typed client is
generic over.

Tier 0 of the titan-platform DAG (TP-138). No runtime dependencies, no zod, no Node
imports, so a browser bundle can import it. `src/browser-safe.test.ts` enforces that the
runtime source imports only its own files and touches no Node global.

```ts
import { CLIENT_HEADER, RPC_PREFIX, SSE_EVENTS, type JsonEnvelope } from "@titan-design/rpc-protocol";

const res = await fetch(`${origin}${RPC_PREFIX}task.list`, {
  method: "POST",
  headers: { "content-type": "application/json", [CLIENT_HEADER]: "my-cli" },
  body: JSON.stringify({ status: "open" }),
});
const envelope = (await res.json()) as JsonEnvelope<Task[]>;
```

## Contents

| Export | What it pins |
| --- | --- |
| `JsonEnvelope<T>`, `successEnvelope`, `errorEnvelope` | `{ ok: true, data, warnings? }` or `{ ok: false, error, code }`; `warnings` is omitted when empty |
| `EXIT` | BSD sysexits codes carried in `code` |
| `RPC_PREFIX`, `EVENTS_PATH`, `HEALTH_PATH`, `VERSION_PATH` | `/rpc/`, `/events`, `/health`, `/version` |
| `CLIENT_HEADER` | `x-titan-client`: a non-browser caller sends it, any non-empty value, on a POST with no `Origin` |
| `RPC_STATUS`, `rpcFailureStatus(code)` | 404 unknown command; 400 invalid JSON or a `DATAERR` failure; 500 any other failure |
| `SseMessage`, `SSE_EVENTS`, `SSE_READY_DATA`, `SSE_HEARTBEAT_MS` | `ready` with data `connected` on connect, `ping` every 25 s, anything else is a product broadcast |
| `CommandMap` | `Record<string, { args: unknown; result: unknown }>` |

`@titan-design/registry` re-exports the envelope and `EXIT`, and `@titan-design/daemon`
re-exports `SseMessage`, so code that imports them from there keeps working.

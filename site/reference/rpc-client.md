# rpc-client

**Tier 1 · engines.** Depends on [`rpc-protocol`](/reference/rpc-protocol) only.

```sh
npm install @titan-design/rpc-client
```

## The problem it solves

Every titan app with a web front end hand-wrote its own `fetch` wrapper around
`POST /rpc/<name>`, its own envelope unwrapping, and its own `EventSource` handling, and
typed the results by copying server types. None of them could run without a daemon, so a
report could not be opened from a file or shared.

The primitive is **a `DataSource`**: one interface with two implementations. `liveSource`
talks to a running daemon; `staticSource` answers from one `titan-snapshot@1` JSON file.
`createRpcClient<M>` puts the command types on top of either, so the same component code
works both ways.

## When to reach for it

Browser or Node code that calls a daemon built on [`daemon`](/reference/daemon) and
[`registry`](/reference/registry), and any report that must also work as a server-less
export. Derive the command map with `CommandMapOf` from `registry`, imported with
`import type` so zod stays out of the bundle. Serving the built app from the daemon is
`daemon.mountStaticApp` (TP-140), and React hooks over a `DataSource` belong in the `ui`
tier's `react-app` (TP-140).

## Example

Verified against 0.1.0.

```ts
import type { CommandMapOf } from "@titan-design/registry";
import { RpcError, createRpcClient, liveSource, parseSnapshot, staticSource } from "@titan-design/rpc-client";
import type { commands } from "../server/commands.js";

type Commands = CommandMapOf<typeof commands>;

const source = embedded
  ? staticSource({ snapshot: parseSnapshot(embedded), resolve: resolveFromDataset })
  : liveSource({ origin: "http://127.0.0.1:7400" });
const client = createRpcClient<Commands>(source);

try {
  const task = await client.call("task.get", { slug: "TP-1" });
} catch (err) {
  if (err instanceof RpcError && err.code === 66) showNotFound();
}

const sub = client.subscribe({ onEvent: () => refetch(), onStatus: setConnection });
sub.close();
```

On the server side, the `./node` entry writes the file:

```ts
import { exportSnapshot } from "@titan-design/rpc-client/node";

await exportSnapshot("out/snapshot.json", registryCaller, {
  calls: [{ command: "task.list" }, { command: "task.get", args: { slug: "TP-1" } }],
  dataset, // optional; a resolver answers any other call from it
});
```

## The snapshot container

`titan-snapshot@1` is one JSON object: `format`, `createdAt` (ISO 8601), `calls` (canonical
key to recorded `JsonEnvelope`), and an optional `dataset`. The key is
`["<command>",<args>]`, where the args are JSON round-tripped the way the daemon receives
them and every object's keys are sorted. `staticSource` answers a recorded call first, then
asks `resolve(command, args, dataset)`, then answers `EXIT.UNAVAILABLE` (69). The dataset's
shape belongs to the package that supplies the resolver; for the codewatch read API that is
`@titan-design/code-read`.

## What it deliberately does not do

No cache, no request deduplication, no retries of calls (only the event stream redials), no
React bindings, no code generation. It does not check results against the command's zod
schema at runtime, because that would put zod in the browser bundle. It has no
`Last-Event-ID` resume, because the daemon does not send ids.

## Gotchas

- **Args are keyed as sent, before defaults.** A snapshot recorded with `{}` does not
  answer `{ limit: 10 }` even when 10 is the default. Record the args the app sends.
- **`CommandMapOf` types args as the command's `Args` parameter**, which products write as
  `z.infer` (the output type). A field with a zod default is therefore required in the
  client call.
- **`call` rejects; `DataSource.call` does not.** A source resolves to an envelope for every
  outcome, including an unreachable daemon (`EXIT.UNAVAILABLE`), and rejects only on abort.
  The client turns failure envelopes into `RpcError`.
- **A page opened from `file://` cannot use `liveSource`.** Its `Origin` is `null`, which the
  daemon's guard refuses. That is what `staticSource` is for.
- **`staticSource.subscribe` reports `open` and then stays quiet.** A snapshot never changes.

## Where it came from

New in September 2026 (TP-139). It replaces the hand-written clients in active-work
(`src/dashboard/utils/api.ts`, `live.ts`), agent-chat (`src/dashboard/live.ts`), and brain.
The static mode exists for the codewatch report app, which must open from a file on a
machine that cannot run a daemon.

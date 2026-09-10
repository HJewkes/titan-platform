# daemon

**Tier 1 · engines.** Depends on [`registry`](/reference/registry) (its own tier), plus
`hono`, `@hono/node-server`, and the MCP SDK. `zod` v4 is a peer.

```sh
npm install @titan-design/daemon @titan-design/registry zod
```

## The problem it solves

Once you have a command registry, hosting it is a day of plumbing you will get subtly wrong:
a pid file that a restart deletes out from under its successor, a `/health` that lies while
the process is still starting, a recursive file watcher that does not actually recurse on
Linux, an SSE endpoint that one dead client wedges.

This package is that plumbing, done once. **It knows nothing about any product**: paths,
port, context, and error formatting are all parameters.

## When to reach for it

You have a `@titan-design/registry` and you want it reachable over HTTP and MCP on loopback.
Or you want just one of the utilities — `watchTree`, the pid-file helpers, `runMcpStdio` —
which are exported separately for exactly that reason.

## Example

Verified against 0.1.1.

```ts
import { startDaemon } from "@titan-design/daemon";

const handle = await startDaemon({
  registry,                                  // CommandRegistry<Ctx>
  createContext: (surface) => ({ warnings: [], format: "json", root, surface }),
  version: "1.0.0",
  stateDir: "~/.local/state/my-product",     // holds daemon.pid + daemon.meta.json
  port: 0,                                   // 0 binds an ephemeral port
  toolPrefix: "my__",                        // omit to skip the /mcp route
  watchRoot: "~/my-product/data",            // omit to skip live reload
  health: () => ({ sessions: 42 }),
  mountRoutes: (app) => app.get("/ui/*", serveDashboard),
});

await fetch(`http://127.0.0.1:${handle.port}/health`).then((r) => r.json());
// { ok: true, version: '1.0.0', sessions: 42, pid: …, uptime_ms: …, port: … }

await fetch(`http://127.0.0.1:${handle.port}/rpc/task.done`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ slug: "TP-1" }),
}).then((r) => r.json());
// { ok: true, data: { ok: true } }

await handle.close(); // stops the watcher, closes the socket, releases the pid file
```

`handle.port` is the bound port, so `port: 0` is usable in tests. `runDaemonUntilSignal`
takes the same options, starts, waits for SIGTERM/SIGINT, then closes. Neither calls
`process.exit` — the caller decides how the process terminates.

## Surfaces

| Route | Behaviour |
| --- | --- |
| `GET /health` | 503 `{ ok: false, starting: true }` until the pid file exists, then version, pid, uptime, port, and your `health()` fields |
| `GET /version` | `{ version }` |
| `GET /events` | SSE; `ready` on connect, `change` on every watch-tree change, `ping` every 25s |
| `POST /rpc/:name` | 404 unknown, 400 bad JSON or bad args (code 65), 500 on a thrown error |
| `POST /mcp` | Stateless MCP; one server and transport per request |

`/rpc` and MCP `CallTool` both go through the registry's `invokeCommand`, so the envelope and
exit codes are identical across surfaces.

## The seams

- **`createContext(surface)`** builds the per-request context. `surface` is `"http"` or
  `"mcp"`. The daemon never knows what your context contains.
- **`health()`** extends `/health` with product state. Core fields win a collision.
- **`mountRoutes(app)`** adds product routes to the same hono app.
- **`formatError`** maps a thrown value to `{ message, code }` for every surface.
- **`logger`** accepts anything with pino's `(fields, message)` shape. A pino instance
  satisfies it structurally with no adapter. `consoleLogger` (stderr) is the default,
  `silentLogger` is there for tests.

## The utilities, usable alone

- `watchTree(root, onChange, { debounceMs, onError })` — portable recursive watcher. It
  watches every subdirectory itself, because `fs.watch`'s `recursive` option is not reliable
  on Linux, and debounces bursts into one callback. `whenWatching(dir)` resolves when a path
  is covered, so tests never sleep.
- `EventHub` — subscribe/broadcast fan-out that drops throwing subscribers rather than
  letting one dead connection wedge the rest.
- `daemonPaths`, `writePidFile`, `readPidFile`, `removePidFile` — atomic (temp-file +
  rename) pid and metadata files.
- `isProcessAlive(pid)`, `getProcessCommand(pid)` — liveness plus the identity check that
  catches a recycled pid.
- `probeHealth(port, { host, timeoutMs })` — `GET /health`, null on any failure.
- `buildHttpApp(options)` — the hono app alone, testable through `app.request()`.
- `createMcpServer`, `attachHandlers`, `listTools`, `invokeTool`, `runMcpStdio` — the MCP
  projection, usable over stdio without running a daemon.

## Gotchas

**`removePidFile(paths, pid)` only unlinks while the file still names `pid`.** That is what
stops a supervised restart from deleting its successor's pid file. Pass the pid you wrote.

**`/mcp` is spliced in ahead of hono on the raw Node server**, because the SDK's
`StreamableHTTPServerTransport` takes ownership of the response object.

**Close order is yours to get right.** If your product runs its own watcher or indexer,
close it *before* the socket: a refresh may be mid-transaction. `startDaemon` closes what it
owns, not what you own.

**On macOS, `XDG_DATA_HOME` does not redirect state.** If you point a test at a clean state
directory, set `HOME`. This has cost real debugging time.

## Where it came from

active-work's `src/server/` (hono), which shrank from 1,302 lines to 632 when it adopted
this package. brain's raw-http server was the other candidate and was worse.

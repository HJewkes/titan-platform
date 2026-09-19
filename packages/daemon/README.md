# @titan-design/daemon

Host a `@titan-design/registry` on a loopback socket: JSON-RPC over HTTP, MCP over
streamable HTTP, Server-Sent Events, a recursive file watcher, and a pid file.

Tier 1 of the titan-platform DAG. Extracted from active-work's `src/server/` (TP-3).
Depends on `hono`, `@hono/node-server`, `@modelcontextprotocol/sdk`, and its tier-1 sibling
`@titan-design/registry`; `zod` is a peer (v4).

The package knows nothing about any product: paths, port, context, and error formatting
are all parameters.

## Run a daemon

```ts
import { mountStaticApp, startDaemon } from "@titan-design/daemon";

const handle = await startDaemon({
  registry,                                   // CommandRegistry<Ctx>
  createContext: (surface) => ({ warnings: [], format: "json", surface }),
  version: "1.4.0",
  stateDir: "~/.local/state/my-product",      // holds daemon.pid + daemon.meta.json
  port: 7400,                                 // 0 binds an ephemeral port
  toolPrefix: "my__",                         // omit to skip the /mcp route
  watchRoot: "~/my-product/data",             // omit to skip live reload
  health: () => ({ index: indexer.status() }),
  mountRoutes: (app) => mountStaticApp(app, { root: "dist/ui", base: "/ui" }),
});

await handle.close(); // stops the watcher, closes the socket, releases the pid file
```

`handle.port` is the bound port, so `port: 0` is usable in tests. `runDaemonUntilSignal`
takes the same options, starts, waits for SIGTERM/SIGINT, then closes. Neither calls
`process.exit` — the caller decides how the process terminates.

## Surfaces

| Route | Behavior |
| --- | --- |
| `GET /health` | 503 `{ ok: false, starting: true }` until the pid file exists, then version, pid, uptime, port, and your `health()` fields |
| `GET /version` | `{ version }` |
| `GET /events` | SSE; `ready` on connect, `change` on every watch-tree change, `ping` every 25s |
| `POST /rpc/:name` | Runs the command: 403 bad Host/Origin, 415 non-JSON Content-Type, 404 unknown, 400 bad JSON or bad args (code 65), 500 on a thrown error |
| `POST /mcp` | Stateless MCP; one server and transport per request |

The paths, the `/rpc` failure statuses, and the SSE event names come from
`@titan-design/rpc-protocol`, which a browser client can import on its own.

## Request guards

Every route is behind three checks, because an unauthenticated daemon on loopback is
reachable from every browser on the machine:

| Check | Applies to | Refusal |
| --- | --- | --- |
| `Host` is in the allowlist | every request | 403 |
| `Origin`, when sent, is in the allowlist | POST/PUT/PATCH/DELETE | 403 |
| `Content-Type` is `application/json` | POST/PUT/PATCH/DELETE | 415 |

The default allowlist is `localhost`, `127.0.0.1`, and `[::1]`, each with and without the
bound port, plus a non-default `host` option; origins are the `http://` and `https://`
forms of those. A request with no `Origin` header — a CLI, curl, an MCP client — is
unaffected, and `GET /health` and `GET /version` stay reachable. A state-changing request
must carry a JSON `Content-Type`, which is exactly what a cross-origin page cannot send
without a preflight the daemon never answers.

```ts
await startDaemon({
  guards: { allowedHosts: ["daemon.internal"], allowedOrigins: ["https://console.internal"] },
  // ...
});
```

`createRequestGuard(options, () => port)` is exported on its own for a product that hosts
its own surfaces.

`/rpc` and MCP `CallTool` both go through the registry's `invokeCommand`, so the envelope
and exit codes are identical across surfaces. `ListTools` uses `commandToTool`, so tool
names are `${toolPrefix}${command.replaceAll(".", "__")}`.

`/mcp` is spliced in ahead of hono on the raw Node server because the SDK's
`StreamableHTTPServerTransport` takes ownership of the response object.

## Serving a built front end

`mountStaticApp(app, { root, base?, immutableDir? })` serves a built app through
`mountRoutes`:

```ts
mountRoutes: (app) => mountStaticApp(app, { root: path.resolve(here, "dashboard"), base: "/ui" }),
```

- `root` is a build directory holding `index.html`, or a single-file build's HTML file.
  Without it, every page answers 503 "not built", so a daemon can start before its front
  end exists.
- `GET <base>/<file>` serves the file with its content type and `nosniff`. Files under
  `immutableDir` (default `assets`, where Vite writes hashed names) get
  `public, max-age=31536000, immutable`. Everything else, `index.html` included, gets
  `no-cache`.
- A path with no extension is a client route and gets `index.html`. A missing file with an
  extension gets 404, because HTML in place of a script hides the real error. `<base>`
  redirects (308) to `<base>/`.
- Traversal is refused. Each segment is decoded once. `.`, `..`, an encoded `/` or `\`,
  NUL, a drive letter, or a bad escape gets 403. The resolved real path must stay inside
  the root's real path, so a symlink leading out also gets 403. Dotfiles are never served.
- Only `GET` is registered, after the core routes and behind the same guards. It cannot
  shadow `/rpc`, `/events`, or `/health`, and the Host check applies to every file.
- Range requests are not honoured: every file comes back whole, with no `Accept-Ranges`,
  so byte-range use such as large source maps or media is out of scope.

## The seams

- `createContext(surface)` builds the per-request context. The daemon never knows what a
  product's context contains; `surface` is `"http"` or `"mcp"`.
- `health()` extends the `/health` payload with product state. Core fields win a collision.
- `mountRoutes(app)` adds product routes (a dashboard, static assets) to the same hono app.
- `formatError` maps a thrown value to `{ message, code }` for every surface.
- `logger` accepts anything with pino's `(fields, message)` shape; `consoleLogger` (stderr)
  is the default and `silentLogger` is available for tests.

## Utilities

Exported on their own because they are the reusable pieces:

- `watchTree(root, onChange, { debounceMs, onError })` — portable recursive watcher. It
  watches every subdirectory itself, because `fs.watch`'s `recursive` option is not
  reliable on Linux, and debounces bursts into one callback. `whenWatching(dir)` resolves
  when a path is covered, so tests never sleep.
- `EventHub` — subscribe/broadcast fan-out that drops throwing subscribers rather than
  letting one dead connection wedge the rest.
- `daemonPaths(stateDir)`, `writePidFile`, `readPidFile`, `removePidFile` — atomic
  (temp-file + rename) pid and metadata files. `removePidFile(paths, pid)` only unlinks
  while the file still names `pid`, so a supervised restart cannot delete its successor's.
- `isProcessAlive(pid)`, `getProcessCommand(pid)` — liveness plus the identity check that
  catches a recycled pid.
- `probeHealth(port, { host, timeoutMs })` — `GET /health`, null on any failure.
- `buildHttpApp(options)` — the hono app alone, testable through `app.request()`.
- `createMcpServer`, `attachHandlers`, `listTools`, `invokeTool`, `runMcpStdio` — the MCP
  projection, usable over stdio without running a daemon.

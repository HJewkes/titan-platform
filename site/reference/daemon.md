# daemon

**Tier 1 · engines.** Depends on [`registry`](/reference/registry) (its own tier) and
[`rpc-protocol`](/reference/rpc-protocol), plus
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
import os from "node:os";
import path from "node:path";
import { mountStaticApp, startDaemon } from "@titan-design/daemon";

const stateDir = path.join(os.homedir(), ".local/state/my-product");
const watchRoot = path.join(os.homedir(), "my-product/data");

const handle = await startDaemon({
  registry,                                  // CommandRegistry<Ctx>
  createContext: (surface) => ({ warnings: [], format: "json", root, surface }),
  version: "1.0.0",
  stateDir,                                  // holds daemon.pid + daemon.meta.json
  port: 0,                                   // 0 binds an ephemeral port
  toolPrefix: "my__",                        // omit to skip the /mcp route
  watchRoot,                                 // omit to skip live reload
  health: () => ({ sessions: 42 }),
  mountRoutes: (app) => mountStaticApp(app, { root: "dist/ui", base: "/ui" }),
});

await fetch(`http://127.0.0.1:${handle.port}/health`).then((r) => r.json());
// { ok: true, version: '1.0.0', sessions: 42, pid: …, uptime_ms: …, port: … }

await fetch(`http://127.0.0.1:${handle.port}/rpc/task.done`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-titan-client": "my-cli" },
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
| `POST /rpc/:name` | 403 bad Host/Origin or no Origin and no `X-Titan-Client`, 415 non-JSON Content-Type, 404 unknown, 400 bad JSON or bad args (code 65), 500 on a thrown error |
| `POST /mcp` | Stateless MCP; one server and transport per request |

`/rpc` and MCP `CallTool` both go through the registry's `invokeCommand`, so the envelope and
exit codes are identical across surfaces.

## Request guards

An unauthenticated daemon on loopback is reachable from every browser on the machine, so
every route is behind four checks: the `Host` header must be in an allowlist (403), a
state-changing request's `Origin`, when it sends one, must be in an allowlist (403), a
state-changing request with no `Origin` must send a non-empty `X-Titan-Client` header (403),
and a state-changing request's `Content-Type` must be `application/json` (415).

The default allowlist is `localhost`, `127.0.0.1`, and `[::1]`, each with and without the
bound port, plus a non-default `host` option; origins are the `http://` and `https://`
forms of those. A state-changing request with no `Origin` header must send
`X-Titan-Client` with any non-empty value, conventionally the caller's name. `GET /health`
and `GET /version` need neither. A state-changing request must also carry a JSON
`Content-Type`. A cross-origin page can send neither the JSON body nor the custom header
without a preflight the daemon never answers.

A missing `Origin` alone is not trusted: browsers have omitted it (old releases, privacy
extensions, webviews), and a loopback peer address proves nothing because the attacking
page runs on this machine too. The header is not a secret and authenticates no one; any
local process can send it. It only proves the sender is not a web page.

Non-browser callers opt in explicitly. `liveSource` from `@titan-design/rpc-client` sends
the header already. A CLI or script adds `x-titan-client: <name>` to its `fetch`. An MCP
client configures it as a transport header, for example `"headers": { "x-titan-client":
"claude-code" }` in `.mcp.json` or `requestInit.headers` on the SDK's
`StreamableHTTPClientTransport`. `CLIENT_HEADER` is exported from `@titan-design/rpc-protocol`
and re-exported here.

```ts
await startDaemon({
  guards: { allowedHosts: ["daemon.internal"], allowedOrigins: ["https://console.internal"] },
  // ...
});
```

## Authentication beyond loopback

The guards keep web pages out but authenticate no one, which is fine on loopback and not on a
LAN. `auth.ts` is the mechanism for a listener that needs a real credential. The product owns
the policy: the file path, the CLI verbs that mint links and rotate the secret, and which
listener the gate sits on. Nothing here is wired into `startDaemon` yet.

```ts
import { Hono } from "hono";
import {
  authGate, createDaemonAuth, ensureTokenFile, mintLoginCode, mountAuthRoutes, rotateTokenFile,
} from "@titan-design/daemon";

const tokenFile = path.join(stateDir, "lan.token");
ensureTokenFile(tokenFile);                    // creates it once: 32 random bytes, 0600, O_EXCL
const auth = createDaemonAuth({ tokenFile });  // throws TokenFileError on an untrustworthy file

app.use("*", authGate(auth));                  // after the Host/Origin guard, before every route
mountAuthRoutes(app, auth);                    // GET+POST /auth/login, POST /auth/logout

// In a separate CLI process, on the daemon's host:
console.log(`http://host:7500/auth/login?code=${mintLoginCode(ensureTokenFile(tokenFile))}`);
rotateTokenFile(tokenFile);                    // ends every session and voids every code
```

- **Token file.** A 32-byte base64url secret. It is refused (`TokenFileError`, with a `problem`)
  when it is a symlink, not a regular file, owned by another user, readable by group or others,
  empty, shorter than 32 bytes, or not base64url. The gate re-reads it whenever its inode, size,
  mtime, ctime, mode or owner change, and re-checks all of the above each time; a file that
  fails the checks after start makes every request 503 until it is fixed. `rotateTokenFile`
  writes a 0600 temp file and renames it into place.
- **Keys.** The secret is never an HMAC key itself. HKDF derives separate cookie, login-code
  and bearer keys, and every comparison is `timingSafeEqual` over equal-length HMAC digests.
- **Login code.** `v1.<issuedAt>.<nonce>.<mac>`, minted offline by anything that can read the
  file. It lives ten minutes and works once per daemon process, and a code minted before the
  process started is refused, so a restart does not revive a spent one.
- **Login is two steps.** `GET /auth/login?code=` returns an inert page (`no-store`,
  `Referrer-Policy: no-referrer`, a nonce CSP) that neither reads nor spends the code, so a
  chat app's link preview cannot burn it. Its button sends a same-origin JSON
  `POST /auth/login { code }`, which spends the code, sets the cookie, and then the script
  navigates to `/`.
- **Session cookie.** `titan_session=v1.<issuedAt>.<mac>`, `HttpOnly; SameSite=Strict; Path=/`,
  `Max-Age` 30 days. It is stateless and survives restarts. The server refuses one from the
  future or 30 days old regardless of the browser. There is no `Secure` flag, because the
  listener this was built for is plain HTTP.
- **Bearer.** Non-browser clients send `Authorization: Bearer <secret>`.
- **Logout.** `POST /auth/logout` clears this browser's cookie only. A copied cookie stays valid
  until it expires or the secret rotates; rotation is the revocation.
- **401s.** A browser `GET` asking for HTML gets a small page with a reload link; everything
  else gets a JSON envelope. Neither names a product's login command.
- **`createContext(surface, auth)`.** The gate records `{ credential: "session" | "bearer",
  issuedAt }` and `/rpc` passes it as `createContext`'s second argument, so a command can refuse
  a credential kind. It is `undefined` on an ungated listener and on MCP.

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

- **`createContext(surface, auth?)`** builds the per-request context. `surface` is `"http"` or
  `"mcp"`; `auth` is what an `authGate` recorded, if one ran. The daemon never knows what your
  context contains.
- **`health()`** extends `/health` with product state. Core fields win a collision.
- **`mountRoutes(app)`** adds product routes to the same hono app.
- **`formatError`** maps a thrown value to `{ message, code }` for every surface.
- **`logger`** accepts anything with pino's `(fields, message)` shape. A pino instance
  satisfies it structurally with no adapter. `consoleLogger` (stderr) is the default,
  `silentLogger` is there for tests.

## The utilities, usable alone

- `watchTree(root, onChange, { debounceMs, onError })` — recursive watcher that debounces
  bursts into one callback. On macOS and Windows it holds one native recursive `fs.watch`
  handle on `root`; elsewhere (Linux), where `recursive` is version-dependent, it walks
  the tree and holds one handle per directory. `isWatching(dir)` is true for any existing
  path under a recursive root even though it has no handle of its own. `whenWatching(dir)`
  resolves when a path is covered, so tests never sleep.
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

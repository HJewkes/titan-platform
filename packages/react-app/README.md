# @titan-design/react-app

React data hooks over `@titan-design/rpc-client`, and a Vite preset for apps a titan daemon
serves. One component tree runs against a live daemon, or as a single HTML file that
carries its data and opens from disk. Components cannot tell which.

Tier `ui` of the titan-platform DAG (TP-140). It holds no components and no styling. Those
live in titan-design's `@titan-design/react-ui`, and no titan-platform library may import
it (the `no-titan-design-library-imports` rule in `.codewatch/check.json`).

## Entries

| Entry | Runs in | Holds |
| --- | --- | --- |
| `@titan-design/react-app` | the browser | `RpcProvider`, `createRpcHooks`, snapshot embedding |
| `@titan-design/react-app/vite` | Node, at build time | `titanApp()`, the dev proxy |

React 18 or 19 is a peer. Vite 6, 7, or 8 is an optional peer, needed only for `./vite`.
The main entry imports only React and the two rpc packages; `src/browser-safe.test.ts` and
the `react-app-browser-no-node` and `react-app-browser-no-vite` rules enforce that.

## Example

```tsx
// src/dashboard/rpc.ts
import type { CommandMapOf } from "@titan-design/registry"; // erased at build
import { createRpcHooks } from "@titan-design/react-app";
import type { commands } from "../server/commands.js";

export const { useQuery, useEvents, useInvalidate, useInvalidateOn } = createRpcHooks<CommandMapOf<typeof commands>>();

// src/dashboard/main.tsx
import { RpcProvider, pageDataSource } from "@titan-design/react-app";

createRoot(root).render(
  <RpcProvider source={pageDataSource()}>
    <App />
  </RpcProvider>,
);

// Any component
function Tasks() {
  useInvalidateOn({ events: ["change"], commands: ["task.list"] });
  const tasks = useQuery("task.list", { status: "open" }); // typed args and result
  if (tasks.status === "loading") return <Spinner />;
  if (tasks.status === "error") return <ErrorNote code={tasks.error.code} message={tasks.error.message} />;
  return <TaskTable rows={tasks.data.slugs} onRefresh={tasks.refetch} />;
}
```

```ts
// vite.config.ts
import react from "@vitejs/plugin-react";
import { titanApp } from "@titan-design/react-app/vite";

export default defineConfig({ plugins: [react(), ...titanApp({ daemonUrl: "http://127.0.0.1:7400" })] });
```

## The hooks

- **`useQuery(name, args?)`** returns `{ status, data, error, isFetching, refetch }`.
  `status` is `loading`, `success`, or `error`. `error` is rpc-client's `RpcError`, with
  the envelope's `code`. A refetch keeps the previous `data` on screen with
  `isFetching: true`, and a failed refetch keeps the last good `data` beside the error.
- Queries are keyed by `snapshotKey(name, args)`, so args that differ only in key order
  share one entry. Components asking for the same key share one call. When the last
  component using a key unmounts, its in-flight call is aborted and the entry is dropped.
- **`useEvents(onEvent?)`** returns the stream status: `connecting`, `open`, or `closed`.
  Every hook under one provider shares one event stream. It opens with the first listener
  and closes after the last.
- **`useInvalidate()`** returns `invalidate(commands?)`, which refetches the watched
  queries for those commands, or all of them.
- **`useInvalidateOn({ events?, commands? })`** invalidates when a matching event arrives,
  and again after the stream reconnects. The daemon keeps no event history, so frames sent
  while the stream was down are lost.

## Two data sources, one app

`pageDataSource()` reads a `<script type="application/json" id="titan-snapshot">` element.
If the page has one, it answers from that snapshot through rpc-client's `staticSource`.
Otherwise it calls the page's own origin through `liveSource`. An exporter writes the
element into a built page with `embedSnapshot(html, snapshot)`. This is pure string work,
so it runs in Node. A browser cannot `fetch` a sibling file from `file://`, which is why
the data goes inside the page.

## The Vite preset

`titanApp({ daemonUrl, singleFile })` returns two plugins.

1. **Dev and preview proxy** for `/rpc/*`, `/events`, `/health`, and `/version`. Each key
   is an anchored regex, because a bare `/rpc` prefix would also capture a module such as
   `/rpc.ts`. The daemon's guards stay in force. See the next section for how.
2. **Single-file build** through `vite-plugin-singlefile`, so the page opens from disk. Pass
   `singleFile: false` for an ordinary multi-file build. `mountStaticApp` serves either.

### How the proxy gets past the daemon's guards without weakening them

The daemon refuses a Host other than its loopback names (403). It refuses a
state-changing request whose Origin is not its own (403), and one without
`Content-Type: application/json` (415). A page on `http://localhost:5173` fails the first
two by construction. For each proxied request, the proxy works as follows:

- **Host.** It rewrites Host to the daemon's `host:port` only when the dev server was
  reached by a loopback name (`localhost`, `127.0.0.1`, or `[::1]`, any port). Any other
  Host goes through untouched, and the daemon refuses it. That is the rebinding case, and
  Vite's own `server.allowedHosts` check normally stops it first.
- **Origin.** It rewrites Origin to the daemon's origin only when the request is
  same-origin with that loopback dev server (`Origin` equals `http://` or `https://` plus
  the Host). A cross-origin page's Origin goes through untouched, and the daemon refuses
  it.
- **Content-Type** is never touched.

In effect, the proxy re-applies the daemon's own rule at the dev server, which is "a
loopback name, and same-origin", and translates only requests that pass it.

## Why no TanStack Query

The need is small. It covers keyed reads, deduplication, abort, refetch, and refetch on an
event. There are no mutations, pagination, optimistic updates, or retries. All three
existing titan apps (active-work, agent-chat, and brain) hand-roll `fetch` plus
`useState`, and none uses a cache library. agent-chat's design note argues for "refetch the
read model on any frame" rather than patching state, and `useInvalidateOn` is that policy.

The built-in store and event bus together are about 170 lines on `useSyncExternalStore`.
The main entry ships in a single-file export, so every kilobyte is in every report.
TanStack Query would also add a second runtime dependency for the owner's batch publish to
vet. If mutations or pagination arrive, TanStack Query can replace the store behind these
same hook names. Consumers never import the store.

## Not done, deliberately

Suspense mode, mutations, optimistic updates, retries with backoff, `enabled` or dependent
queries (render the child conditionally instead), keeping unwatched entries warm, a
router, and debounce of invalidation bursts. A burst aborts and restarts the call, and the
daemon still runs each one.

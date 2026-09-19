# react-app

**Tier ui.** Depends on [`rpc-client`](/reference/rpc-client) and
[`rpc-protocol`](/reference/rpc-protocol). React 18 or 19 is a peer, and Vite 6 to 8 is an
optional peer for the `./vite` entry.

```sh
npm install @titan-design/react-app @titan-design/rpc-client react
```

## The problem it solves

active-work, agent-chat, and brain each hand-rolled the same front-end plumbing: a `fetch`
wrapper that unwraps the envelope, `useState` plus `useEffect` per view, an `EventSource`
that refetches on every frame, and a Vite proxy whose unanchored keys once blanked a page.
None of them can run without its server.

This package is that plumbing, done once. It has one provider and four hooks, typed from
the product's command map. The data source is chosen at the root, so the same components
render from a live daemon or from a snapshot embedded in a single HTML file.

## When to reach for it

A product serves a React front end from `@titan-design/daemon`, or exports one as an
offline report. For the typed calls alone, outside React (a CLI, an exporter, tests), use
[`rpc-client`](/reference/rpc-client). For serving the built files, use `mountStaticApp`
from [`daemon`](/reference/daemon). For components, use titan-design's `react-ui`. This
package has none.

## Example

Verified against 0.0.0, from packed tarballs, with React 19.3, Vite 8.3, and Chromium 153.

```tsx
import type { CommandMapOf } from "@titan-design/registry"; // erased at build
import { RpcProvider, createRpcHooks, pageDataSource } from "@titan-design/react-app";
import type { commands } from "../server/commands.js";

const { useQuery, useInvalidateOn } = createRpcHooks<CommandMapOf<typeof commands>>();

function Notes() {
  const stream = useInvalidateOn({ events: ["notes.changed"], commands: ["note.list"] });
  const list = useQuery("note.list");
  if (list.status === "loading") return <p>loading</p>;
  if (list.status === "error") return <p>{list.error.code}: {list.error.message}</p>;
  return <p title={stream}>{list.data.ids.join(", ")}</p>;
}

createRoot(root).render(<RpcProvider source={pageDataSource()}><Notes /></RpcProvider>);
```

```ts
// vite.config.ts
import react from "@vitejs/plugin-react";
import { titanApp } from "@titan-design/react-app/vite";

export default defineConfig({ plugins: [react(), ...titanApp({ daemonUrl: "http://127.0.0.1:7400" })] });
```

```ts
// Offline export, in Node: record the calls, then put the snapshot inside the built page.
import { buildSnapshot } from "@titan-design/rpc-client";
import { embedSnapshot } from "@titan-design/react-app";

const snapshot = await buildSnapshot(registryCaller, { calls: [{ command: "note.list" }] });
await writeFile("report.html", embedSnapshot(await readFile("dist/index.html", "utf8"), snapshot));
```

## Exports

| Export | Entry | What it does |
| --- | --- | --- |
| `RpcProvider({ source })` | main | Holds the query cache and one shared event stream for its subtree |
| `createRpcHooks<M>()` | main | `useQuery`, `useEvents`, `useInvalidate`, and `useInvalidateOn`, typed from `M` |
| `pageDataSource(options?)` | main | `staticSource` over the embedded snapshot if the page has one, otherwise `liveSource` |
| `embedSnapshot(html, snapshot)` and `readEmbeddedSnapshot(doc?)` | main | Write and read `<script type="application/json" id="titan-snapshot">` |
| `titanApp({ daemonUrl?, singleFile? })` | `./vite` | The dev and preview proxy plus `vite-plugin-singlefile` |
| `daemonProxy`, `daemonHeaders`, `PROXIED_ROUTES` | `./vite` | The proxy pieces, for a config that composes its own |

`useQuery` returns `{ status, data, error, isFetching, refetch }`. `status` is a
discriminant, so `data` is typed as present once `status` is `success`.

## What it deliberately does not do

It has no components, styling, or tokens. Those belong to titan-design, and a check.json
rule stops any library here from importing `@titan-design/react-ui`. It has no mutations,
optimistic updates, retries, Suspense mode, `enabled` flag, or router. It has no cache
library. The store is about 160 lines, and the package README says why it is not TanStack
Query. It does not resume missed events. The daemon sends no event ids, so
`useInvalidateOn` refetches after a reconnect instead.

## Gotchas

**Every hook under one provider shares one event stream.** Browsers allow about six
HTTP/1.1 connections per origin, so one stream per component would starve the calls.

**The proxy does not open the daemon up.** It rewrites Host and Origin only for a
same-origin request to a loopback dev server. Anything else reaches the daemon unchanged,
and the daemon refuses it. Content-Type is never touched. A cross-origin page gets the
same 403 through the proxy as it gets directly.

**Proxy keys are anchored regexes.** A bare `/rpc` prefix also matches a module named
`/rpc.ts`, and the page renders blank. Compose `daemonProxy()` instead of writing your own
keys.

**The last unmount aborts.** A key's in-flight call is aborted one tick after its last
component unmounts. That tick lets a StrictMode remount keep the call.

**A browser cannot fetch a sibling file from `file://`.** An offline export therefore
embeds its snapshot in the page rather than shipping it beside the page.

**Tests under jsdom.** jsdom replaces `AbortSignal`, and Node's `fetch` rejects a foreign
signal. Give `liveSource` a `fetch` that bridges the signal. `src/test-fixtures.ts` has
one.

## Where it came from

New, in TP-140, from the front-end kit decision in the codewatch initiative's
`design-react-ui-monorepo-question.md`. It replaces active-work's `utils/api.ts` and
`utils/live.ts`, agent-chat's `useLiveData` and dashboard Vite proxy, and the
`viteSingleFile` configuration that all three apps copied.

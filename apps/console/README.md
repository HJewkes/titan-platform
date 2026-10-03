# titan-console

One read-only console over three local sources: the active-work daemon, the agent-chat broker
and the session graph. It is one app shell built from `@titan-design/react-ui`, and one
loopback daemon built from `@titan-design/daemon` and `@titan-design/registry`. The browser
talks only to that daemon, through `@titan-design/react-app` hooks typed from the daemon's own
command definitions. The app is private and publishes nothing.

This is the skeleton (TP-842). It serves the shell, hash routes and a nav for every planned
view, and it answers one command, `upstreams.health`. Every view except Status is a
placeholder that names the task that builds it.

## Run it

```sh
pnpm install --frozen-lockfile
pnpm --filter "titan-console..." build     # the app, its bin, and the workspace packages they import
pnpm --filter titan-console serve          # http://127.0.0.1:7500/
```

| Mode | How | What runs |
| --- | --- | --- |
| Dev | `pnpm --filter titan-console dev` | Vite on :5173 proxies `/rpc` to the console daemon on :7500 |
| Served | `pnpm --filter titan-console serve`, or `node apps/console/dist/cli.js` (the `titan-console` bin) | The daemon serves the single-file build through `mountStaticApp` beside `/rpc` |
| From disk | `pnpm --filter titan-console export` | Writes `dist/console.html` with its first-paint answers embedded by `embedSnapshot`; open it with no daemon |

`serve` prints the address and answers until SIGINT or SIGTERM:

```
titan console: http://127.0.0.1:7500/ (pid 4242)
```

## Ports and settings

The console listens on **7500**, loopback only. It never uses 7400, because the active-work
daemon and `titan-miner serve` both default to it. It refuses to start on a port that one of
its upstreams uses, and on a port value that is not a number.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TITAN_CONSOLE_PORT` | `7500` | The console daemon's own port |
| `TITAN_CONSOLE_STATE` | `~/.local/state/titan-console` | Holds the daemon's pid file; a second console over the same directory is refused |
| `TITAN_CONSOLE_ACTIVE_WORK_PORT` | `7400` | Loopback port of the active-work daemon |
| `TITAN_CONSOLE_AGENT_CHAT_PORT` | `7600` | Loopback port of the agent-chat broker |
| `TITAN_CONSOLE_SESSION_GRAPH` | `<active-work root>/.miner/graph.sqlite3` | Path of the session graph file |

The active-work root is `ACTIVE_ROOT` when set. Otherwise it is the data directory
active-work's own CLI resolves through `env-paths`: the platform's application data
directory, under the name `active-work`.

## The daemon

| Route | Answers |
| --- | --- |
| `GET /health` | The daemon package's health payload, plus the three upstream targets. It does not probe them, so it answers at once |
| `POST /rpc/upstreams.health` | `{ checkedAt, upstreams: [{ id, label, target, reachable, detail }] }` for `work`, `agents` and `sessions` |
| `GET /events` | The daemon package's SSE stream; nothing publishes to it yet |
| `GET /` and any client route | The built app, or a "not built" page until `build` has run |

Three rules hold for every later slice.

- **Loopback HTTP only.** The console imports no other product's source. It reaches the two
  daemons at `127.0.0.1:<port>`; only the port is configurable.
- **It starts nothing.** A probe is one `GET /health` with a one second timeout. An upstream
  that does not answer is reported as unreachable, and the console never spawns it.
- **Read-only.** There is no command that writes, answers a queue item, or controls an agent.

The session graph probe uses `stat` only. The file can be larger than a gigabyte and another
process writes it, so the console does not open it. TP-844 adds the read-only, per-request open.

The upstream ids are the namespaces later commands live under: `work.*`, `agents.*` and
`sessions.*`. `server/commands.ts` is the single list of commands. `src/data/rpc.ts` derives
the browser's hook types from it with `CommandMapOf`, and a test calls the running daemon
through `createRpcClient` with the same type.

## Routes

Hash routes, because a page opened from disk has no server to answer a pushed path.

| Route | Rail label | View | Built by |
| --- | --- | --- | --- |
| `#/` | Status | Upstream reachability | this slice |
| `#/initiatives` | Work | Initiative portfolio and detail | TP-861 |
| `#/tasks` | Tasks | Read-only board and task detail | TP-866 |
| `#/sessions` | Sessions | Sessions list, conversation, sidebar, replay | TP-862, TP-863 |
| `#/agents` | Agents | Roster with costs, topology, agent-to-agent chat | TP-864, TP-865 |
| `#/productivity` | Flow | Productivity and quality | TP-867 |
| `#/knowledge` | Notes | Notes and sources, then the knowledge graph | TP-869, TP-871 |
| `#/search` | Search | Search and the what-is-where inventory | TP-870 |
| `#/stores` | Stores | Databases and file roots | TP-872 |

The command palette (TP-868) is an overlay, so it has no route.

## Design system

Every element on screen is a `@titan-design/react-ui` component: `AppShell`, `TopBar`,
`BrandLockup`, `EmptyState`, `Section`, `Card`, `DataRow`, `Badge`, `Typography`, `Spinner`
and `Alert`. The app has no component or style of its own. `src/styles.css` holds only the
three Tailwind directives, and `index.html` makes the mount point a full-height frame because
`AppShell` fills its parent.

Gaps found while building, for the titan-design lane. Each is stubbed with the nearest
existing piece, not worked around with local styles.

| Gap | What the console does until it is filled |
| --- | --- |
| No `console` brand preset in `shell/brands` | Borrows the `agents` preset and overrides the wordmark |
| No search, database or chart glyph in `components/icons` | Search uses `TargetIcon`, Stores uses `EqualIcon`, Flow uses `AwardIcon` |
| No page container for `AppShell`'s content region | Views render flush against the rail, with no inset |
| `NavItem` sets `accessibilityState`, which react-native-web 0.21 does not turn into `aria-selected` | The active item is marked visually only; the test finds it by the accent bar |

## Layout

```
server/   config.ts (ports and paths), upstreams.ts (the three probes), commands.ts,
          registry.ts, daemon.ts, cli.ts (the bin), dev.ts, export.ts
src/      main.tsx, App.tsx (the shell), router.ts, views.tsx (the nav and its placeholders),
          pages/, data/rpc.ts (typed hooks)
```

Tests sit beside the code. `server/*.test.ts` start the real daemon on an ephemeral port
against a fake upstream on loopback. `src/app.test.tsx` renders the whole app from an
embedded snapshot, the way an exported page runs.

```sh
pnpm exec vitest run apps/console
```

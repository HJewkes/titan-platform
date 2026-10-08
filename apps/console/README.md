# titan-console

One read-only console over three local sources: the active-work daemon, the agent-chat broker
and the session graph. It is one app shell built from `@titan-design/react-ui`, and one
loopback daemon built from `@titan-design/daemon` and `@titan-design/registry`. The browser
talks only to that daemon, through `@titan-design/react-app` hooks typed from the daemon's own
command definitions. The app is private and publishes nothing.

The skeleton (TP-842) serves the shell, hash routes and a nav for every planned view. The
first real view is Initiatives (TP-861): the portfolio and one initiative's detail, read from
the active-work daemon. The daemon also answers `agents.roster` and `agents.graph` (TP-847),
which no view shows yet. Every other view except Status is a placeholder that names the task
that builds it.

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
| From disk | `pnpm --filter titan-console export` | Writes `dist/console.html` with its first-paint answers embedded by `embedSnapshot`; open it with no daemon. It records the status and the portfolio, with no personal initiative |

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
| `TITAN_CONSOLE_AGENT_CHAT_TOKEN` | `$AGENT_CHAT_HOME/ui.token`, else `~/.agent-chat/ui.token` | The broker's 0600 token file, read on every agents call |
| `TITAN_CONSOLE_SEATS` | none | `seat=prefix` pairs, comma separated; an agent named `<prefix>-...` belongs to that seat |
| `TITAN_CONSOLE_SESSION_GRAPH` | `<active-work root>/.miner/graph.sqlite3` | Path of the session graph file |

The active-work root is `ACTIVE_ROOT` when set. Otherwise it is the data directory
active-work's own CLI resolves through `env-paths`: the platform's application data
directory, under the name `active-work`.

## The daemon

| Route | Answers |
| --- | --- |
| `GET /health` | The daemon package's health payload, plus the three upstream targets. It does not probe them, so it answers at once |
| `POST /rpc/upstreams.health` | `{ checkedAt, upstreams: [{ id, label, target, reachable, detail }] }` for `work`, `agents` and `sessions` |
| `POST /rpc/agents.roster` | `AgentRosterSnapshot` from `@titan-design/chat-protocol/agents`: live presence, then agents known only from broker history |
| `POST /rpc/agents.graph` | `AgentGraph`: the spawn tree, plus `spawned` and `message` edges with counts, keyed by roster ids |
| `POST /rpc/work.portfolio` | Every initiative with its state, brief `taskPrefix`, open-task rollup, note, source and session counts, newest activity and `personal` flag |
| `POST /rpc/work.tasks` | Open tasks across initiatives, each with a `stage` from titan-design's task-stage vocabulary, the `stageRule` and `stageReason` behind it, and `stageGuessed` when no evidence was found |
| `POST /rpc/work.task` | `{ id }` in; that task with its stage, notes, done_when, mentions, `artifacts.yml` rows with PR state, live refs and open PRs, and the sessions whose `session_origin.task_ids` name it. An unknown id is not found (66) |
| `POST /rpc/work.initiative` | `{ slug }` in; that initiative's brief, the 200 most urgent open tasks with the full count, 20 most recent sessions, open loops, notes, top-level sources and a count of nested ones out |
| `GET /events` | The daemon package's SSE stream; nothing publishes to it yet |
| `GET /` and any client route | The built app, or a "not built" page until `build` has run |

`work.tasks` derives stages from the local clones that any `artifacts.yml` names. Per clone it
reads local refs, worktrees and main-line subjects with `git` (it never fetches) and open pull
requests with one `gh` call, cached for a minute. A failed GitHub read is listed under
`evidence.degraded` and leaves the review stage unset rather than failing the command.

Three rules hold for every later slice.

- **Loopback HTTP only.** The console imports no other product's source. It reaches the two
  daemons at `127.0.0.1:<port>`; only the port is configurable.
- **It starts nothing.** A probe is one `GET /health` with a one second timeout. An upstream
  that does not answer is reported as unreachable, and the console never spawns it.
- **Read-only.** There is no command that writes, answers a queue item, or controls an agent.

## active-work reads

`server/active-work.ts` is the only code that calls the active-work daemon. It posts to
`/rpc/<command>` on loopback with a ten second timeout, and it can call only the reads in its
`READS` table: `list`, `task.list`, `inventory`, `session.list`, `loops` (offline, so a page
view never makes active-work call GitHub), `note.list`, `source.list` and `source.read`. Each
answer is parsed against the part of the shape the console uses. The browser never calls
active-work, and no absolute file path is sent to it.

**Personal initiatives.** active-work's `inventory` marks an initiative `human_only`, and
marks every initiative when it cannot read which ones are. The console shows these with a
`personal` badge. The console does not rely on that marking alone: when `human_only_known`
is false it treats every initiative as personal, and it does the same for an initiative the
inventory does not name. The
export builds its registry with `excludePersonal`, so `dist/console.html` holds no personal
initiative, and none at all when active-work could not say.

The session graph probe uses `stat` only. The file can be larger than a gigabyte and another
process writes it, so the console does not open it. TP-844 adds the read-only, per-request open.

The `agents.*` commands read the broker's `/api/sessions` and `/api/history?limit=1000` with
the `X-Agent-Chat-Token` header, which is the path agent-chat's own queue mirror uses. The
token reaches the broker's page by HTML injection only, so a browser cannot call the broker,
but a process running as the same OS user can read the 0600 token file. A missing token, a
rejected token or a silent broker is an error envelope with code 69, never an empty roster.
`costUsd` comes from the agent's exit report for now; the session-analytics price joins when
the sessions commands read transcripts.

The upstream ids are the namespaces later commands live under: `work.*`, `agents.*` and
`sessions.*`. `server/commands.ts` is the single list of commands. `server/commands.ts` turns
that list into the `ConsoleCommands` type with `CommandMapOf`, `src/data/rpc.ts` derives the
browser's hook types from it with `createRpcHooks<ConsoleCommands>`, and a test calls the running daemon
through `createRpcClient` with the same type.

## Routes

Hash routes, because a page opened from disk has no server to answer a pushed path.

| Route | Rail label | View | Built by |
| --- | --- | --- | --- |
| `#/` | Status | Upstream reachability | this slice |
| `#/initiatives` | Work | Initiative portfolio: cards by state, then record counts per initiative | TP-861 |
| `#/initiatives/<slug>` | Work | One initiative: header, open loops, brief, and tabs for open tasks, sessions, notes and sources | TP-861 |
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
and `Alert`, and for the Initiatives view the `custom/ActiveWork` family (`PortfolioOverview`,
`InitiativeHeader`, `OpenLoops`, `InitiativeBrief`, `TaskTable`, `SessionList`) with `Table`,
`Tabs`, `Breadcrumbs`, `Link`, `Pill` and `DateTime`. The app has no component or style of its own. `src/styles.css` holds only the
three Tailwind directives, and `index.html` makes the mount point a full-height frame because
`AppShell` fills its parent.

Gaps found while building, for the titan-design lane. Each is stubbed with the nearest
existing piece, not worked around with local styles.

| Gap | What the console does until it is filled |
| --- | --- |
| No `console` brand preset in `shell/brands` | Borrows the `agents` preset and overrides the wordmark |
| No search, database or chart glyph in `components/icons` | Search uses `TargetIcon`, Stores uses `EqualIcon`, Flow uses `AwardIcon` |
| No page container for `AppShell`'s content region | Views render flush against the rail, with no inset |
| `InitiativeCard` has no press handler and no slot for record counts, newest activity or a personal mark | The portfolio adds a `Table` under `PortfolioOverview` that carries the counts, the `personal` badge and the link into the detail |
| No list or reader for notes and sources (TP-859) | The detail lists both in a dense `Table`; nothing opens a note or a source yet |
| `TabPanels` is `flex-1`, so in a card of automatic height it gets half the room its content needs and clips | The detail renders `Tabs` with a `TabList` only, and puts the active panel beside it |
| `SessionSummary` requires the session body, and `SessionList` has no way to ask for it on selection | Sessions are listed with an empty body, so a row shows no task count and opens nothing |
| `Link` and `BreadcrumbItem` take `href` but render no anchor | Navigation goes through `onPress`; a row cannot be opened in a new tab |
| No scrolling page container for `AppShell`'s content region | A long view overflows the frame and the document scrolls, top bar included |
| `NavItem` sets `accessibilityState`, which react-native-web 0.21 does not turn into `aria-selected` | The active item is marked visually only; the test finds it by the accent bar |

## Layout

```
server/   config.ts (ports and paths), paths.ts (the built page and export locations),
          upstreams.ts (the three probes), active-work.ts (the read-only client), broker.ts (the
          read-only agent-chat broker client), work.ts (the work.* read models), agents.ts (the
          agents.* commands), commands.ts (the command list and `ConsoleCommands`), registry.ts,
          daemon.ts, cli.ts (the bin), dev.ts, export.ts, fixtures.ts (synthetic answers),
          test-support.ts (a fake daemon for tests)
src/      main.tsx, App.tsx (the shell), router.ts, views.tsx (the nav and its placeholders),
          pages/, data/rpc.ts (typed hooks)
```

Tests sit beside the code. `server/*.test.ts` start the real daemon on an ephemeral port
against a fake upstream on loopback. `src/*.test.tsx` render the whole app from an embedded
snapshot, the way an exported page runs. Every fixture is synthetic (`server/fixtures.ts`);
no test reads a real active-work root.

```sh
pnpm exec vitest run apps/console
```

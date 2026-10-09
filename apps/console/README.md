# titan-console

One read-only console over three local sources: the active-work daemon, the agent-chat broker
and the session graph. It is one app shell built from `@titan-design/react-ui`, and one
loopback daemon built from `@titan-design/daemon` and `@titan-design/registry`. The browser
talks only to that daemon, through `@titan-design/react-app` hooks typed from the daemon's own
command definitions. The app is private and publishes nothing.

The skeleton (TP-842) serves the shell, hash routes and a rail of six (TP-1057). The
first real view is Initiatives (TP-861): the portfolio and one initiative's detail, read from
the active-work daemon. The daemon also answers `agents.roster` and `agents.graph` (TP-847), and `agents.messages` and `agents.queue` (TP-1059),
which no view shows yet. Every other view except Home is a placeholder that names the task
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

`serve` prints the address, and the LAN address too in LAN mode, and answers until SIGINT or SIGTERM:

```
titan console: http://127.0.0.1:7500/ (pid 4242)
titan console on the LAN: https://lan-box.example.ts.net:7500/ (sign in with `titan-console login-link`)
```

## Ports and settings

The console listens on **7500**, on loopback only unless LAN mode is on (see below). It never uses 7400, because the active-work
daemon and `titan-miner serve` both default to it. It refuses to start on a port that one of
its upstreams uses, and on a port value that is not a number.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TITAN_CONSOLE_PORT` | `7500` | The console daemon's own port |
| `TITAN_CONSOLE_STATE` | `~/.local/state/titan-console` | Holds the daemon's pid file; a second console over the same directory is refused |
| `TITAN_CONSOLE_ACTIVE_WORK_PORT` | `7400` | Loopback port of the active-work daemon |
| `TITAN_CONSOLE_AGENT_CHAT_PORT` | `7600` | Loopback port of the agent-chat broker |
| `TITAN_CONSOLE_AGENT_CHAT_TOKEN` | `$AGENT_CHAT_HOME/ui.token`, else `~/.agent-chat/ui.token` | The broker's 0600 token file, read on every agents call and refused (exit 78) if group or others have any access |
| `TITAN_CONSOLE_EVENTS_DB` | `$AGENT_CHAT_HOME/events.db`, else `~/.agent-chat/events.db` | agent-chat's event log, opened read-only by `agents.messages`; when it will not open, that command falls back to the broker's history window |
| `TITAN_CONSOLE_SEATS` | none | `seat=prefix` pairs, comma separated; an agent named `<prefix>-...` belongs to that seat |
| `TITAN_CONSOLE_SESSION_GRAPH` | `<active-work root>/.miner/graph.sqlite3` | Path of the session graph file |
| `TITAN_CONSOLE_HOST` | none | Turns LAN mode on: one IP address on this machine's interfaces, such as its tailscale address, served over HTTPS behind auth. Loopback, a wildcard, a name or an address the machine does not have is refused |
| `TITAN_CONSOLE_LAN_NAMES` | the hostname and `<hostname>.local` | Comma list of DNS names the LAN listener answers to; the first goes into login links. Set it to the tailnet name: the certificate must cover every name, so the defaults fail start. A port, an IP or a loopback name is refused |
| `TITAN_CONSOLE_TLS_CERT` | none | PEM certificate the LAN listener serves, such as the `.crt` from `tailscale cert`. Required with `TITAN_CONSOLE_HOST`; set with `_KEY` or not at all |
| `TITAN_CONSOLE_TLS_KEY` | none | Its PEM key; refused unless it is this user's and mode 0600. Both files are re-read within a minute of a change |
| `TITAN_CONSOLE_TOKEN` | `$TITAN_CONSOLE_STATE/lan.token` | The LAN secret, created at 0600 on first use; refused if it is group- or world-readable, a symlink, short or someone else's |
| `TITAN_CONSOLE_OWNER_WRITES` | `0` | `1` lets owner-write commands run on the LAN (see "Who may run a command"). Turning it on is an owner step. Any value but `0` or `1` is refused |
| `TITAN_CONSOLE_INBOX_DIR` | `$TITAN_CONSOLE_STATE/inbox/deposits` | The owner-inbox spool `inbox.deposit` files into, created 0700 on the first deposit |

The active-work root is `ACTIVE_ROOT` when set. Otherwise it is the data directory
active-work's own CLI resolves through `env-paths`: the platform's application data
directory, under the name `active-work`.

## LAN mode

With `TITAN_CONSOLE_HOST` unset the console is exactly the loopback daemon above. With it set,
the console adds a second listener on that address and the same port, through the daemon
package's `remote` option. That listener speaks only HTTPS, with the certificate and key named by
`TITAN_CONSOLE_TLS_CERT` and `_KEY`, so a plain-HTTP request to it gets no reply. There is no
setting that binds the LAN without TLS or without auth. The loopback listener is unchanged and
needs no credentials.

On the LAN listener the Host guard runs first: only `TITAN_CONSOLE_HOST` and the LAN names,
each with the bound port, are answered, and anything else, `localhost` included, gets 403. A
state-changing request's `Origin` must be `https://` one of those, with the port.
Then every route, the page and `/health` included, needs a session cookie or
`Authorization: Bearer <secret>`, and answers 401 without one. `/mcp` is never served there.

```sh
titan-console login-link     # prints https://<first LAN name>:7500/auth/login?code=...
titan-console token rotate   # rewrites lan.token at 0600; every session and link ends
```

- **`login-link`** mints a code from the token file, so it needs no running daemon. It works
  once and for ten minutes, and a daemon that restarts after minting refuses it. Run it with
  the same `TITAN_CONSOLE_PORT`, `_STATE`, `_TOKEN` and `_LAN_NAMES` as the service. The link
  is printed to your terminal and nowhere else. Opening it shows a sign-in page that does
  nothing on its own, so a chat app's link preview cannot spend the code. Its button posts the
  code as JSON, and that sets a Secure, HttpOnly, SameSite=Strict cookie that lasts 30 days.
- **`token rotate`** writes a fresh secret by rename. The running daemon re-reads the file,
  so every session and outstanding link ends with no restart. This is how to revoke a lost
  device.
- **Logout** is `POST /auth/logout` with a JSON body. It clears that browser's cookie only;
  a copied cookie stays valid until a rotation.

Nothing is exposed until the service unit sets `TITAN_CONSOLE_HOST`; installing that unit is an
owner step. The unit and the tailscale certificate, install, login, renewal, rotate and rollback
commands are in [docs/lan.md](docs/lan.md).

## The daemon

| Route | Answers |
| --- | --- |
| `GET /health` | The daemon package's health payload, plus the three upstream targets. It does not probe them, so it answers at once |
| `POST /rpc/upstreams.health` | `{ checkedAt, upstreams: [{ id, label, target, reachable, detail }] }` for `work`, `agents` and `sessions` |
| `POST /rpc/agents.roster` | `AgentRosterSnapshot` from `@titan-design/chat-protocol/agents`: live presence, then agents known only from broker history |
| `POST /rpc/agents.graph` | `AgentGraph`: the spawn tree, plus `spawned` and `message` edges with counts, keyed by roster ids |
| `POST /rpc/agents.messages` | `{ agent, peer?, before?, limit? }` in; that agent's messages, or the pair's, newest first. From events.db with `nextCursor`, the row id to pass as `before`; from `/api/history` with `partial: true` and the window when events.db will not open |
| `POST /rpc/agents.queue` | `{ include_system? }` in; open items waiting on the human from `/api/queue`, questions first, each with `asker` and `ageMs`. The broker's own notices are counted in `hidden` unless `include_system` is set |
| `POST /rpc/work.portfolio` | Every initiative with its state, brief `taskPrefix`, open-task rollup, note, source and session counts, newest activity and `personal` flag |
| `POST /rpc/work.tasks` | Open tasks across initiatives, each with a `stage` from titan-design's task-stage vocabulary, the `stageRule` and `stageReason` behind it, `stageGuessed` when no evidence was found, and `parent`, `dep` and `deliverables` read with `@titan-design/pm`'s `readEdges` (the field, else the edge tags) |
| `POST /rpc/work.task` | `{ id }` in; that task with its stage, notes, done_when, mentions, `artifacts.yml` rows with PR state, live refs and open PRs, the sessions whose `session_origin.task_ids` name it, its `children`, and each deliverable id joined to its `deliverable.list` record (`null` when unknown; `deliverablesDegraded` when the registry is unread). An unknown id is not found (66) |
| `POST /rpc/work.initiative` | `{ slug }` in; that initiative's brief, the 200 most urgent open tasks with the full count, 20 most recent sessions, open loops, notes, top-level sources and a count of nested ones out |
| `POST /rpc/inbox.deposit` | An `ownerItemDeposit` in; `{ id, created }` out. The one write, a `deposit` (see "Owner inbox deposits") |
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
- **Read-only, apart from deposits.** The one write is `inbox.deposit`, which files an item but
  cannot answer one. No command answers a queue item or controls an agent. A later one must
  take a class below.

## Who may run a command

Every command the registry serves carries a class, set by `server/owner-guard.ts`. A refusal
is 403 with the envelope code 77 (`EXIT.NOPERM`) and a reason that names the class. It never
echoes a cookie, the token or a login code.

| Class | Runs for |
| --- | --- |
| `read` | Anyone the listener lets in: loopback with no credentials, the LAN with a cookie or bearer. Every command but `inbox.deposit` is a read |
| `deposit` | An HTTP call: on loopback, where every POST already needs an allowlisted `Origin` or `X-Titan-Client`, or on the LAN with either credential |
| `owner-write` | Only the owner's session cookie on the LAN listener, from a peer that is not this machine, while `TITAN_CONSOLE_OWNER_WRITES=1` |

Owner writes answer for the owner: answers, approvals and merge gates. Loopback carries no
credential and every same-user process can read `lan.token`, so loopback and
`Authorization: Bearer` both get 403. A same-user agent can still mint a login link and curl
the LAN address, so a cookie arriving from one of this machine's own addresses is refused
too. With the switch off, owner writes answer "owner writes are off". The handler
receives the verified session's `issuedAt` as `ctx.ownerPresence`, the owner-console
presence proof. An owner-write handler is defined with `ownerWrite: true` and wrapped by
`ownerWriteCommand`. `readCommand` and `depositCommand` refuse a marked handler at runtime,
when they wrap it and again at registry build. The types refuse it too. `run` is a property in
`@titan-design/registry`, so a handler whose `run` needs `ctx.ownerPresence` neither passes to
`readCommand` or `depositCommand` nor widens to `Command<…, ConsoleContext>` or `AnyCommand`
(an annotation, a factory's return type, an array). Both helpers also refuse a handler whose
context has any key `ConsoleContext` lacks, checked in every member of a union context. One
that declares `ownerPresence` optional, or takes `ConsoleContext | OwnerWriteContext`, fails to
compile too. Only widening or a cast gets past the types, and the `ownerWrite` mark is the guard then.
TypeScript has no exact types, so an optional-presence handler widened before it reaches a
helper still compiles; it runs with no proof, because only `ownerWriteCommand` adds one.
Commands run only through `POST /rpc/<name>`, so no owner write is a GET.
The OS account is still the trust boundary: this stops an agent answering for the owner by
accident or as a confused deputy, not a hostile process running as the same user.

## Owner inbox deposits

Any agent files an owner item with `inbox.deposit`, or from a shell:

```sh
titan-console inbox file '{"depositId":"ask-1","asker":"my-agent","kind":"decide",...}'
titan-console inbox file - < deposit.json   # - or no argument reads stdin
```

The CLI posts to `127.0.0.1:$TITAN_CONSOLE_PORT` only, refuses a redirect, and prints the item
id alone. On a refusal it prints the console's reason and exits 1; it never echoes the body.

- **Strict body.** `ownerItemDepositSchema` from `@titan-design/owner-queue` refuses any field
  only the system sets: `id`, `sources`, `status`, `answer`, `route`, `authority`, `lint` and
  `recommended.hidden`. Each answers 400 and files nothing.
- **One file per deposit.** `owner-queue/spool`'s `writeDeposit` writes it at 0600 under
  `TITAN_CONSOLE_INBOX_DIR`. The file name percent-encodes `asker` and `depositId`, so `../`, `/`
  and NUL cannot leave the spool, and `Bob` and `bob` get two files. An `asker` or `depositId`
  holding a lone surrogate answers 400.
- **Idempotent.** A repeat of an asker's `depositId` keeps the first body and answers its item
  id with `created: false`.
- **Caps.** A request body over 128 KB answers 413 before the daemon buffers it. A deposit over
  64 KB, measured as the spool stores it, answers 400. The body cap is twice the stored one
  because a client that writes non-ASCII as `\uXXXX` escapes sends up to twice the bytes. An
  asker with 200 open deposits, those with no answer file beside them, gets 429
  (`EXIT.TEMPFAIL`) until one is answered, and so does every asker once the spool holds 2000
  open deposits. Deposits run one at a time, so racing calls cannot pass a cap together.
- **Trust limit.** `asker` comes from the body and is self-declared: loopback carries no
  identity, and a LAN credential names no agent. One agent can file under another's name, and
  can spread past the per-asker cap across invented names, up to the spool-wide 2000. A
  deposit still cannot answer or resolve anything, so this costs inbox noise, not owner
  authority.

## active-work reads

`server/active-work.ts` is the only code that calls the active-work daemon. It posts to
`/rpc/<command>` on loopback with a ten second timeout, and it can call only the reads in its
`READS` table: `list`, `task.list`, `inventory`, `session.list`, `loops` (offline, so a page
view never makes active-work call GitHub), `note.list`, `source.list`, `source.read`, `artifact.list`, `artifact.status`, `context.graph` and
`deliverable.list` (active-work 0.23 on, read only for a task that names a deliverable). Each
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
| `#/` | Home | Upstream reachability, until the Home page lands | TP-1061 |
| `#/initiatives` | Work | Initiative portfolio: cards by state, then record counts per initiative | TP-861 |
| `#/initiatives/<slug>` | Work | One initiative: header, open loops, brief, and tabs for open tasks, sessions, notes and sources | TP-861 |
| `#/tasks`, `#/tasks/<id>` | Tasks | Tasks grouped by derived stage, and task detail | TP-866a |
| `#/sessions`, `#/sessions/<id>` | Sessions | Sessions list, and one session with its conversation first | TP-862 |
| `#/agents`, `#/agents/<name>` | Agents | Roster, spawn tree and message feed, and one agent | TP-864a, TP-865a |
| `#/knowledge`, `#/knowledge/<ref>` | Notes | Notes and sources with a reader, and a Graph tab | TP-869, TP-871a |

Any route keeps its query string (`#/tasks?task=<id>`, `#/knowledge/<ref>?tab=graph`) in `Route.query`.
A knowledge ref holds `:` and `/`, so `href` encodes the whole ref as one segment. An unknown view,
including Flow, Search and Stores, which left the rail, opens Home.

`src/pages/index.ts` maps a view to its page, one entry per page; a rail entry with no entry
renders its placeholder. `src/refs.ts` holds `refToRoute`, the one place a ref (`task:`, `note:`,
`source:`, `session:`, `agent:`, `pr:`, `code:`) becomes a console route, a GitHub pull request
or a codewatch file, and `initiativeForTask`, which finds a task's initiative from its id prefix.

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
| No home glyph exported from `components/icons` | Home uses `ActivityIcon` |
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
src/      main.tsx, App.tsx (the shell), router.ts, refs.ts (refToRoute), views.tsx (the rail and
          its placeholders), pages/ (index.ts is the page registry), data/rpc.ts (typed hooks)
```

Tests sit beside the code. `server/*.test.ts` start the real daemon on an ephemeral port
against a fake upstream on loopback. `src/*.test.tsx` render the whole app from an embedded
snapshot, the way an exported page runs. Every fixture is synthetic (`server/fixtures.ts`);
no test reads a real active-work root.

```sh
pnpm exec vitest run apps/console
```

# titan-console

One read-only console over four local sources: the active-work daemon, the agent-chat broker,
the session graph and titan-factory's `needs.list`. It is one app shell built from `@titan-design/react-ui`, and one
loopback daemon built from `@titan-design/daemon` and `@titan-design/registry`. The browser
talks only to that daemon, through `@titan-design/react-app` hooks typed from the daemon's own
command definitions. The app is private and publishes nothing.

The skeleton (TP-842) serves the shell, hash routes and a rail of six (TP-1057). The
first real view is Initiatives (TP-861): the portfolio and one initiative's detail, read from
the active-work daemon. Home (TP-1061) reads upstream health, the portfolio, `work.tasks`, `agents.roster`,
`agents.queue` and `sessions.list`, and links each queue item out to agent-chat. Agents
(TP-864a, TP-865a) shows the roster, `agents.graph` (TP-847) and `agents.messages` (TP-1059).
Every other view is a placeholder that names the task that builds it.

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
| Twin captures | `pnpm --filter titan-console capture` | Builds the page, renders every route from the typed twin fixtures with no daemon, and writes PNGs to `dist/twin`; see [Twin captures](#twin-captures) |

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
| `TITAN_CONSOLE_FACTORY_PORT` | `7410` | Loopback port of `titan-factory serve`, whose `needs.list` `approvals.flow` reads with no token, only the `X-Titan-Client` header. Refused if it equals the console's own port |
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
| `TITAN_CONSOLE_ROUNDS_DIR` | `$TITAN_CONSOLE_STATE/rounds` | Review rounds, one `<round-id>/round.json` each, read by `rounds.list`, `rounds.get` and `approvals.flow`. `fixtures/rounds` holds synthetic ones for a browser check |
| `TITAN_CONSOLE_AUTONOMY_DIR` | none | The autonomy tree `config.surfaces` reads `charter.md` and `seats/*.md` from, and the tree `config.compareTree` imports; unset, `config.surfaces` answers a gap for them and `config.compareTree` answers `not-configured`. It must be an absolute or `~/` path. `burndown.config.json` and `seat-watchdog.json` are read from `$AGENT_CHAT_HOME`, else `~/.agent-chat`. Only fields each surface's allowlist in `server/config-surfaces/catalog.ts` names carry a value |
| `TITAN_CONSOLE_VIDEO_ROOTS` | none | Directories the theater lists `.mp4` and `.webm` renders from, joined with `:` (`;` on Windows), such as `$HOME/<data-dir>`. Walked to depth 8, skipping dot-dirs, `node_modules`, `archive` and symlinks, capped at 2000 videos. `videos.list` returns them by opaque id; `GET /media/videos/<id>` serves one with byte ranges and `/media/videos/<id>/captions` its `<name>.vtt`. A relative entry is refused; unset, the list is empty with one gap line |
| `TITAN_CONSOLE_REVIEWS_DIR` | `<active-work root>/titan-platform/sources/research/repo-review` | Repo reviews, read by `reviews.list`: each direct subfolder with a `README.md` is one review, and only fixed paths inside it are opened (no-follow, 1 MB cap). A file that fails to read or parse is a gap line, never a hidden review |
| `TITAN_CONSOLE_INBOX_ACTIONS` | `0` | `1` lets `inbox.act` write an action record and post it to the factory (see "The inbox and its actions"). Turning it on is an owner step. Any value but `0` or `1` is refused |
| `TITAN_CONSOLE_DECISIONS_FILE` | none | The owner's decisions file the decision log appends one-way, A/B and policy answers to (see "The decision log"). Owner config only, never taken from a request; a relative path is refused. Unset, only `answers.jsonl` is written |
| `TITAN_CONSOLE_FACTORY_CONFIG` | `$XDG_CONFIG_HOME/titan-factory/config.json`, else `~/.config/titan-factory/config.json` | The factory config `config.surfaces` reads. Like every file that command reads (agent-chat's `config.json` and `profiles/*.json` under `$AGENT_CHAT_HOME`, each Claude account's `settings.json` and `.claude.json`), only fields its allowlist in `server/config-surfaces/catalog.ts` names carry a value. `digest.push` is never named |
| `TITAN_CONSOLE_CLAUDE_DIRS` | `~/.claude` and every `~/.claude-profiles/*` | Comma list of Claude Code config dirs `config.surfaces` reads. From `.claude.json` it reports only the trusted-folder count and the MCP server names |

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
  The cookie is the whole session, signed with the token file, so it survives a daemon
  restart. The phone flow is in [docs/lan.md](docs/lan.md#on-a-phone).
- **`token rotate`** writes a fresh secret by rename. The running daemon re-reads the file,
  so every session and outstanding link ends with no restart. This is how to revoke a lost
  device.
- **Logout** is `POST /auth/logout` with a JSON body. It clears that browser's cookie only;
  a copied cookie stays valid until a rotation.

The console is the single owner origin. Shepherd (titan-factory on `TITAN_CONSOLE_FACTORY_PORT`)
and the review rounds are reached from other devices only through this login: the console
proxies three Shepherd reads, `shepherd.list`, `shepherd.timeline` and `shepherd.waiting`, to
`127.0.0.1` server-side and no Shepherd write, and serves the rounds pages itself. The factory
stays loopback-only with its own Host and Origin guards. There is no `tailscale serve` path
router in front of the backends, and Funnel is never used.

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
| `POST /rpc/agents.messages` | `{ agent?, peer?, before?, limit? }` in; every agent's messages, that agent's, or the pair's (`peer` needs `agent`), newest first. From events.db with `nextCursor`, the row id to pass as `before`; from `/api/history` with `partial: true` and the window when events.db will not open |
| `POST /rpc/agents.queue` | `{ include_system? }` in; open items waiting on the human from `/api/queue`, questions first, each with `asker` and `ageMs`. The broker's own notices are counted in `hidden` unless `include_system` is set |
| `POST /rpc/work.portfolio` | Every initiative with its state, brief `taskPrefix`, open-task rollup, note, source and session counts, newest activity and `personal` flag |
| `POST /rpc/work.tasks` | Open tasks across initiatives, each with a `stage` from titan-design's task-stage vocabulary, the `stageRule` and `stageReason` behind it, `stageGuessed` when no evidence was found, and `parent`, `dep` and `deliverables` read with `@titan-design/pm`'s `readEdges` (the field, else the edge tags) |
| `POST /rpc/work.task` | `{ id }` in; that task with its stage, notes, done_when, mentions, `artifacts.yml` rows with PR state, live refs and open PRs, the sessions whose `session_origin.task_ids` name it, its `children`, and each deliverable id joined to its `deliverable.list` record (`null` when unknown; `deliverablesDegraded` when the registry is unread). An unknown id is not found (66) |
| `POST /rpc/work.initiative` | `{ slug }` in; that initiative's brief, the 200 most urgent open tasks with the full count, 20 most recent sessions, open loops, notes, top-level sources and a count of nested ones out |
| `POST /rpc/work.notes` | Notes and top-level sources across every initiative, newest change first, each with its `note:<slug>/<file>` or `source:<slug>/<path>` ref |
| `POST /rpc/work.record` | `{ ref }` in; that note or source with its markdown body and `truncated` when active-work's read cap cut it. A ref with a `..` segment is refused (65) and a missing file is not found (66) |
| `POST /rpc/work.search` | `{ q }` in; active-work's `search` hits by ref, and the retrievers that failed under `degraded` |
| `POST /rpc/rounds.list` | Every round in the rounds dir, newest first, `open` or `sent` (a `feedback.json` sits beside it), plus `dir`, the rounds dir the server reads. A manifest that fails `RoundSchema` from `@titan-design/review-schema`, round@1 included, is listed with the schema's reason. Symlinked round directories are skipped |
| `POST /rpc/rounds.get` | `{ id }` in; that round's manifest. While an `after-answer` round is unsent, every question's recommendation is stripped. A round with a merge-bound pick-one is flagged `ship`; any other round with frames is flagged `design`. The detail carries `manifestSha256` (what `rounds.submit` binds to) and, once the factory has answered a Ship or Send back, an optional `answer {status, at, choice?, currentHead?, reason?}` (`choice` is `merge` or `send-back`). A Ship round also carries `lineage`: `{known: true, provenSha, state, merged, mergeSha, headSha, baseRef, baseSha, behind}` read from GitHub's PR and base tip and cached per repo, PR and head for a minute (`behind` is null unless the PR is open and still at the proven head), or `{known: false, reason}`. `round.json` is read without following symlinks and only up to 1 MiB; an unknown or unsafe id is not found (66) |
| `POST /rpc/rounds.frames` | `{ id }` in; `{ indexed, frames: [{ key, theme?, views, indexed }] }` out: each frame the round lists, from its image variants and `frames/frames.json`, with the views (`head`, `base`, `after`, `diff`) it has files for. The top `indexed` says the round has a `frames/frames.json`, and a frame's `indexed` says that file lists it. An invalid `frames.json` is refused (66) |
| `POST /rpc/rounds.frame` | `{ id, key, view? }` in; `{ contentType: "image/png", bytes, sha256, base64 }` out for one listed frame. The client names a key and view, never a path. Refused (66) for an unlisted key or view, a path leaving the round, a symlink at any component, a non-regular file, a non-PNG, a file over 8 MiB or a sha256 the frames index does not match. Also served over `/mcp`, so an agent can read the images as the owner does |
| `POST /rpc/rounds.submit` | `{ id, manifestSha256, headSha?, answers, general? }` in; `{ status: "submitted", path, sha256, headSha }` or `{ status: "already-submitted" }` out. An `owner-write`: writes the round's `feedback.json` in the `feedback@1` shape once (`wx`, mode 0600), never overwriting. Refused (65) when `manifestSha256` is not the sha256 of `round.json` on disk, when a Ship pick on a merge-bound question lacks the head sha it names, for an unknown question id, an option the question does not offer, a design round (a round with frames and no merge-bound question) without a valid `frames/frames.json`, or feedback over 64 KiB. An unknown or unsafe id, symlinks included, is not found (66). It resolves no gate |
| `POST /rpc/approvals.flow` | The owner's one merged queue: `{ flow, gaps, fyiCount, readAt }` (see "The approvals flow") |
| `POST /rpc/inbox.deposit` | An `ownerItemDeposit` in; `{ id, created }` out. A `deposit` (see "Owner inbox deposits") |
| `POST /rpc/config.report` | Another host's `titan config report` in; `{ host, receivedAt }` out. A `deposit` taken only over a bearer from another machine (see "Host config reports") |
| `POST /rpc/config.drift` | `{ rows: [{ id, label, status, values, sources: [{ surface, field, file, line, value }], absent }], gaps }`: each value kept in more than one config file on this host (the worktree cap per repo, the load5 hold, and a lone roster seat's implementer cap against `maxAgents`). `status` is `drift` when any two copies disagree; drift rows come first. The home `CLAUDE.md` is read only for the "<n> per repo" it states |
| `POST /rpc/config.hosts` | `{ hosts: [{ host, status, reportedAt, receivedAt, platform, surfaces }], gaps }`: each other host's last report. One older than 25 hours is `not reported`, with no surfaces |
| `GET /events` | The daemon package's SSE stream, carrying the upstream events relay (see "Live updates"). At most 64 browsers at once (one more gets 503); a browser 256 frames behind is disconnected and redials |
| `GET /` and any client route | The built app, or a "not built" page until `build` has run |

`work.tasks` derives stages from the local clones that any `artifacts.yml` names. Per clone it
reads local refs, worktrees and main-line subjects with `git` (it never fetches) and open pull
requests with one `gh` call, cached for a minute. A failed GitHub read is listed under
`evidence.degraded` and leaves the review stage unset rather than failing the command.

Three rules hold for every later slice.

- **Loopback HTTP only.** The console imports no other product's source. It reaches the
  active-work daemon, the broker and the factory at `127.0.0.1:<port>`; only the port is configurable.
- **It starts nothing.** A probe is one `GET /health` with a one second timeout. An upstream
  that does not answer is reported as unreachable, and the console never spawns it.
- **Read-only, apart from three writes.** `inbox.deposit` files an item but cannot answer one.
  `config.report` stores another host's config report under the state dir and applies nothing.
  `rounds.submit`, an `owner-write`, records the owner's answers to a round as its
  `feedback.json` and resolves nothing itself. No command controls an agent. A later write must
  take a class below.

### The decision log

After `rounds.submit` writes `feedback.json`, the console records each answered question in
`$TITAN_CONSOLE_STATE/answers.jsonl`: one row per answer, in the `@titan-design/decider` ledger
shape (`source: "queue"`, keyed `round:<round>:<question>:<submittedAt>`), appended with
`O_APPEND|O_NOFOLLOW` to a file kept at mode 0600. A one-way, A/B (a decide with two or more options
and a pick) or policy (a D-row `class`, or category `policy`) answer also gets one bullet under
`## Queue answers <date>` in `TITAN_CONSOLE_DECISIONS_FILE`, which must already exist. A Ship
approval is two-way, so it reaches the ledger only. A personal item, an item of a human-only
initiative, or any answer while active-work cannot say which initiatives are human-only writes
nothing. A failed log write never undoes the submit: the result's `log` array says what was
written per question, with a reason that names no path, and the daemon log has the error.

## Live updates

The daemon holds one SSE connection to each upstream's `/events` (`server/events-relay.ts`)
and rebroadcasts each upstream event on its own `/events`, one frame per upstream frame, keep-alives aside.
The frame's SSE event name is its source and its data is a small JSON object:

| Source | Upstream frame | What the browser gets |
| --- | --- | --- |
| `active-work` | `change`, whose data is the watched directory | `{ kind }` only; the path stays behind |
| `agent-chat` | an event-log row: id, kind, actor, target, msgId, ref, body, meta | `{ kind, id, actor, target }`: the row id and the two agent names, each dropped unless it is an integer or a plain name. Body, meta, ref and msgId stay behind |
| either | the stream reopened after a drop | `{ kind: "reconnected" }`, since frames sent while it was down are lost |

- **Same auth as `/rpc`.** On the LAN listener `/events` sits behind the session cookie or
  bearer like every other route; loopback is open, as for `/rpc`. The relay is read-only.
- **Tokens stay in the daemon.** The broker token is read from `TITAN_CONSOLE_AGENT_CHAT_TOKEN`
  on every dial and sent only to the broker, as a header, with redirects refused.
- **Bounded.** One connection per upstream; a refused or dropped dial redials after 0.5 s,
  doubling to 30 s. The backoff resets only after a stream has stayed up for 10 s, so an
  upstream that drops every stream at once keeps backing off and is warned about once. A dial with no answer in 3 s, a stream silent for 60 s (both upstreams
  heartbeat every 25 s) and a frame over 1 MiB end the connection. Browser streams are capped
  as in the table above. Stopping the daemon closes every upstream socket and timer.

`useRelayInvalidation` (`src/data/live.ts`), mounted once by the shell, refetches the open
pages' active-work reads (`work.*`, `graph.ego`) on an `active-work` frame and their `agents.*`
reads on an `agent-chat` frame, and all of them after the browser's own stream reopens. Each
source refetches at most once per 300 ms, at the end of the window, so a burst of broker
appends costs one refetch per tab rather than one per append.

While that stream is down after having opened, the shell shows one warning line above every
page, "Data may be old since" the time it dropped (`useStaleSince`, `src/data/stale.ts`). The
line clears when the stream reopens.

## Who may run a command

Every command the registry serves carries a class, set by `server/owner-guard.ts`. A refusal
is 403 with the envelope code 77 (`EXIT.NOPERM`) and a reason that names the class. It never
echoes a cookie, the token or a login code.

| Class | Runs for |
| --- | --- |
| `read` | Anyone the listener lets in: loopback with no credentials, the LAN with a cookie or bearer. Every command but `inbox.deposit` and `config.report` is a read |
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

## Host config reports

`config.surfaces` reads this host's files directly. Another host, such as a laptop, runs
`titan config report --to https://<lan-name>:<port> --token-file <path>`, which posts its
report to `config.report`; `config.hosts` shows it.

- **Data, not authority.** A report names files and their facts (present, mode, mtime, size,
  sha256), never a value. The schema is strict at every level, so a field it does not name,
  a `revision` to apply among them, answers 400 and stores nothing. The handler writes only
  `$TITAN_CONSOLE_STATE/config/host-reports/<host>.json` (0600, by rename) and nothing else.
- **A bearer from another machine only.** Loopback carries no credential, and any local
  process can read `lan.token`, so a report from loopback, a session cookie or a bearer whose
  peer is this machine gets 403. A host name is lowercase letters, digits and dashes; at most 16
  hosts are kept, and a repeat replaces that host's report.
- **Stale is not reported.** A report older than 25 hours, by the older of its own
  `reportedAt` and the console's `receivedAt`, shows `not reported` with no surfaces.

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
- **Caps.** A request body over 192 KB answers 413 before the daemon buffers it. A deposit over
  64 KB, measured as the spool stores it, answers 400. The body cap is three times the stored
  one because a client that writes non-ASCII as `\uXXXX` escapes sends six bytes for each
  two-byte character (U+0080 to U+07FF) and twelve for each four-byte astral one. An
  asker with 200 open deposits, those with no answer file beside them, gets 429
  (`EXIT.TEMPFAIL`) until one is answered, and so does every asker once the spool holds 2000
  open deposits. Deposits run one at a time, so racing calls cannot pass a cap together.
- **Trust limit.** `asker` comes from the body and is self-declared: loopback carries no
  identity, and a LAN credential names no agent. One agent can file under another's name, and
  can spread past the per-asker cap across invented names, up to the spool-wide 2000. A
  deposit still cannot answer or resolve anything, so this costs inbox noise, not owner
  authority.

## Importing a review round

A review-harness round dir, or a CI visual packet built into one, lands in the rounds dir from a
shell:

```sh
titan-console rounds import <round-dir>          # id, frames: N, feedback: copied|kept|none, URLs
titan-console rounds import <round-dir> --json   # one line: {id, created, frames, feedback, url, lanUrl}
```

It writes to `TITAN_CONSOLE_ROUNDS_DIR` as `<unit>-r<round>/` and prints
`http://127.0.0.1:$TITAN_CONSOLE_PORT/#/rounds/<id>`, plus the LAN URL when `TITAN_CONSOLE_HOST`
is set. Run it with the same `TITAN_CONSOLE_*` settings as the service, or the round lands in a dir
the service does not read. A refusal prints its reason to stderr and no URL, exits non-zero, and
writes nothing. The verb is local only: no `/rpc` command imports a round.

- **Validated as the console reads it.** `round.json` and `feedback.json` must pass the parsers
  `rounds.list` and the owner queue use. `frames/frames.json` must carry the sha256 of that
  `round.json` and its unit and round. Only the files it lists (`file`, `base`, `diff`, `after`)
  are copied, each sha256-checked through the `rounds.frame` reader.
- **CI packets.** A `packet.json` or `prose.json` that frames.json names is copied beside
  `round.json` after a sha256 and JSON check. The packet's repo, PR and head must equal every
  merge-bound Ship question in the round, because the factory's Ship answer route reads it there.
- **No symlinks.** A symlink at the source dir, `frames/`, or any file it reads is refused.
- **Idempotent.** A new round is staged in a dot-named dir and renamed into place. A re-import of
  the same `round.json` and `frames.json` adds only missing files. A changed `round.json` is
  refused with "build round n+1", and an existing `feedback.json` is never replaced.

## Theater

The theater lists the renders under `TITAN_CONSOLE_VIDEO_ROOTS` and keeps the owner's notes on
each one beside the video, in `<name>.notes.jsonl` (`cut.mp4` gets `cut.notes.jsonl`). The sidecar
is the store of record: an agent re-rendering a video reads it in place, and nothing is copied into
the state dir.

- **`videos.note`** (owner-write) appends one line: `{ videoId, atS, kind: "comment", text }` or
  `{ videoId, atS, kind: "verdict", verdict: "ship" | "needs-changes" }`. Like `rounds.submit`, it
  runs only for the owner's session cookie on the LAN listener with `TITAN_CONSOLE_OWNER_WRITES=1`,
  so loopback and bearer calls are refused.
- **`videos.notes`** (read) returns `{ video, notes, verdict, gaps }` for one video id. Each note
  carries `current`, and `verdict` is the latest verdict on the current render or null.
- **`videos.list`** gives each video a `noteCount` (comments on the current render), an
  `openNoteCount` (the open notes under the pickup rule below) and its `verdict`.

Each line is a strict `titan-console/video-note@1` object:

| Field | Value |
| --- | --- |
| `schema` | `"titan-console/video-note@1"` |
| `id` | 16 random hex |
| `videoId`, `video` | the catalog id and the video's file name, never a path |
| `renderSha256` | sha256 of the video's bytes when the note was made |
| `atS` | playback time in seconds, at or above 0, rounded to 0.001 |
| `kind` | `"comment"` with `text` (1-2000 characters), or `"verdict"` with `verdict` |
| `createdAt` | ISO time |

The file is opened with O_APPEND and O_NOFOLLOW, mode 0600, and each note is one write of at most
4 KB, so concurrent appends never interleave. A reader skips a line it cannot parse and reports the
count as a gap, and refuses a file over 1 MB.

**Agent pickup rule.** Read `<name>.notes.jsonl`. A note is on the current render when its
`renderSha256` equals the video's sha256 now. The open notes are the current render's comments
written after its latest `ship` verdict, in file order: `openNotes(notes, currentSha)` in
`server/video-notes.ts`. A Ship on an earlier render closes nothing. Re-rendering the video makes
every earlier note an earlier-render note: it stays in the file as history and is never open again.

### Video metadata

Agents describe a render in two files the console only reads. `<stem>.video.json` beside the
video (`cut.mp4` gets `cut.video.json`) is a strict `titan-console/video-meta@1` object.
`_videos.json` in a folder is a strict `titan-console/video-folder@1` object that covers a batch
of clips without one sidecar each. `videos.list` adds every field that is set to the video's
row. A video with neither file lists with only what its file and folder give (below).

| Field | Value |
| --- | --- |
| `schema` | `"titan-console/video-meta@1"`; the only required field |
| `title` | 1-200 characters, replacing the file stem; include the take ("Lantern walkthrough, take 2") |
| `description` | 1-2000 characters |
| `purpose` | one of `daily`, `repo-review`, `plan`, `design`, `explainer`, `test`, `clip` |
| `tags` | up to 20 strings of 1-40 characters |
| `subject` | `{ kind: "repo" \| "day" \| "initiative", id }`: what the video is about |
| `parent` | for a clip, the id or alias of the video it was cut from |
| `posterAtS` | seconds, at or above 0: the frame to use as the poster |
| `poster` | a jpg or png file name in the video's folder (no path), served by the poster route below |
| `alias` | lowercase `[a-z0-9._-]`, up to 80: a stable name that survives a file move, unlike the id |
| `series`, `take` | 1-200 characters each |
| `status` | the agent's claim: `draft`, `review`, `final` or `superseded` (the owner's call is the verdict) |

The folder manifest carries `schema: "titan-console/video-folder@1"`, any of the fields above
except `title` and `alias` as defaults for every video directly in that folder, and `items`, a
map from a file name to its own fields (`{ "01-spin.mp4": { "title": "Spin" } }`). A field in
the sidecar beats the manifest's item for that file, which beats the manifest's default.

Both files are opened with O_NOFOLLOW and read up to 64 KB. A file that is bigger, not JSON, or
not a strict match is skipped and counted as a gap ("1 video sidecar could not be read", "1 video
folder manifest could not be read"); the videos still list. A parsed file is cached by its device,
inode, size and mtime, so the per-request rescan reads only files that changed.

### Poster and resolve

`GET /media/videos/:id/poster` serves the video's cover, found beside the video: the sidecar's
`poster`, else `<stem>-poster.jpg`, else `<stem>-poster.png`, else 404. It resolves the id and
root as the video route does, opens nothing outside the root, and refuses a symlink or a file that
is not regular. A contact sheet is never a poster, and nothing is resized: writers produce 480 w
JPEGs. It sends the image type and `Cache-Control: private, no-cache`, like the video.

**`videos.resolve`** (read) takes `{ series?, tag?, subject? }` (`subject` is the subject's `id`) and
returns `{ found: true, id }` for the newest non-superseded video that matches every filter, or
`{ alias }` and returns that video's id. When nothing matches it returns `{ found: false, reason }`.

### Media fields, derived fields and copies

Every row also carries what the video's own headers say: `durationS`, `width`, `height`,
`orientation` (`landscape`, `portrait` or `square`) and `audio`. An mp4 is read box by box
(`mvhd`, then each track's `tkhd` and `hdlr`, wherever the `moov` sits); a webm is read from its
first 256 KB of EBML. A file whose headers cannot be parsed lists with those fields null and counts
toward one gap line ("1 video header could not be read"). A recorder webm with no Duration lists
with `durationS: null` and no gap. Results are cached by device, inode, size and mtime.

When no sidecar or manifest sets them, the catalog derives:

- `title`: the H1 of `render-notes.md` beside the video, then of `BRIEF.md`, then the file stem.
  When siblings in one folder derive the same title, each gets its take appended
  ("Lantern walkthrough (v2)"), or its stem when it has no take.
- `description`: the first paragraph after the H1 that gave the title.
- `series`, `take`: from a `-v2`, `_take3` or `-take-3` suffix on the stem (`lantern-v2` is take
  `v2` of `lantern`).
- `superseded`: the sidecar's `status` is `superseded` when one is set; otherwise true when a later
  take (higher number, then newer file) of the same series sits in the same folder.

A file under a `copies` or `intermediate` folder whose size and sha256 of its first and last 64 KB
match another listed video folds into that video, whose `copies` counts it. Identical files
outside those folders never fold. A folded copy's id still resolves on the media routes.

### The feed

`#/theater` sections the renders by day in the reader's own timezone (Today, Yesterday, a
weekday within the week, then the date), newest first, each header counting its videos and their
run time. A row shows the title, one purpose pill, at most one flag (Old take, else Phone for a
portrait render), the verdict and note pills, and a byline. The purpose is the sidecar's
`purpose`, else a tag naming one, else `clip` under 10 seconds, else `repo-review` or `daily`
from the `subject` or series, else Other (`purposeOf()` in `src/pages/theater-feed.ts`). Its
colour is only the dot beside the label, from the dataviz categorical hues.

The state lives in the hash, so a filtered feed is a link: `?q=` searches the title, description,
series, folder, subject and tags; `?tag=<purpose>` narrows to one purpose chip; `?old=1` shows
superseded takes. Without a search or a chip, clips wait behind their chip and each day header
links to its own.

## The approvals flow

`approvals.flow` (`server/approvals.ts`) is a read. It merges three legs through
`@titan-design/owner-queue`'s `consolidate` and returns `{ flow, gaps, fyiCount, readAt }`:

- **Factory.** `server/factory.ts` posts `needs.list` to `127.0.0.1:$TITAN_CONSOLE_FACTORY_PORT`
  with a ten second timeout: agent-chat asks, hitl gates, Morning items and needs-decision tasks.
  An item that fails `ownerItemSchema` is a gap line naming its id; the rest are kept. Items whose
  first source is `deposit` are dropped, because the console reads its own spool.
- **Spool.** `server/approval-items.ts` reads `TITAN_CONSOLE_INBOX_DIR`; a deposit with an answer
  file beside it counts as answered. A deposit's `gate:` and `run:` keys are removed, so an
  agent-written deposit never takes a hitl gate's place.
- **Rounds.** An unsent round gives one open item per question; a round with a valid
  `feedback.json` gives answered items instead, never both. A missing rounds dir is no rounds.

Each leg catches its own failure into a `gaps` line prefixed `factory:`, `spool:` or `rounds:`, so a
dead source never reads as an empty queue. `lens: fyi` items are counted in `fyiCount`, not
ordered. An unanswered after-answer question's recommendation is removed from `order`,
`withdrawn` and `dropped`, as `rounds.get` does. A PR group's `shipBlockedBy` lists open change
requests (free text, or a pick other than the implemented one); an unanswered question never
blocks. hitl gates carry no `pr:` key yet (TP-2053), so a gate sits in a topic group.

## The inbox and its actions

`inbox.list` (`server/inbox-view.ts`) is a read: `approvals.flow`'s order joined to Shepherd's live rows, each item
with the one action a tap takes, or the terminal command and why the console offers none. A write action comes only
from a hitl gate joined to a live Shepherd row; a deposit never gets one.

A tap is two calls (`server/inbox-actions.ts`). Both answer "inbox actions are off" until
`TITAN_CONSOLE_INBOX_ACTIONS=1`. They act on `resolve-gate` (an approve-merge gate), `owner-release` (an
owner-asked hold), `answer-chat` (an agent's chat_ask) and a `hold-release` of a `g10-review` or `g10-adversary`
hold; any other item, a hold of another class included, answers `no-action` with its reason.

1. `inbox.prepare({ itemId })` is a read. It re-reads the inbox and returns the read-back (repo, PR, title, head,
   gate id or hold, and the effect in one sentence) with a `confirm` digest. The digest is the sha256 of the item
   id, its action, its hold, the read-back and the read time. The console keeps it for five minutes and accepts no confirm it did
   not issue.
2. `inbox.act({ itemId, confirm })` is an owner-write, so the owner admission in "Who may run a command" runs first.
   It reads the inbox again and refuses, before anything is written or posted, when the digest no longer matches.
   It then writes `$TITAN_CONSOLE_STATE/owner-actions/<confirm>.json` once (O_EXCL, 0600, in a 0700 dir). The
   record holds the item, its action and read-back, the confirm, the session's `issuedAt` and the peer class,
   never the cookie. The console posts `{ actionId }` to the factory's `POST /owner/console-action`.

The factory reads the record and decides; its resolver is `owner-remote` `titan-console` on `console:inbox`, with
the record's sha256 as the confirm event. The console pins the route's answers in `server/owner-action.ts`:

| Factory answer | Owner sees |
| --- | --- |
| 200 `resolved` / `released` (with `stillHeld`) | "Merge approved" / "Hold released", plus any hold left |
| 200 `already` | "Already done by this confirmation": a replay reposts the same record bytes |
| 409 `moved` | "PR moved to `abc1234`, read again" |
| 410 `gone`, 403 or 422 `refused` | the reason |
| 404 | the route is not mounted: the factory has no `consoleAnswers.actionsDir` |
| 5xx, a redirect, no answer | unreachable; the tap may be retried with the same confirm |

A settled outcome is written once as `<confirm>.outcome.json`. A landed resolve or release also writes one
decision-log row (see "The decision log"), and a replay does not write it again. The factory's
`consoleAnswers.actionsDir` must name the same `owner-actions` dir. The factory trusts the OS account, as for
answer-ship: a same-user process could write a record and post its id. That is no stronger than running
`titan-factory gate resolve` from the same account, and it is not claimed to be.

An `answer-chat` tap differs in three ways (`server/broker-answer.ts`). Its read-back is the question: the message
id, summary, asker, context, the asker's options and recommendation. `inbox.act` takes the owner's words as `text`
(required, trimmed, at most 8000 characters; a gate or hold tap refuses any text), and the record keeps them, so a
retry sends the words first written. The console posts `{ msgId, text, channel: "dashboard" }` to the agent-chat
broker's `POST /api/answer` on loopback, with the 0600 `ui.token` re-read per call, and never follows a redirect.
The broker arbitrates, so a question answered first elsewhere comes back `closed` and logs nothing. A refused
token mode, a redirect, a 5xx or no answer is unreachable, and the tap may be retried. An approval or permission
prompt never reaches this path: `inbox.list` gives it a terminal action.

A g10 `hold-release` tap (`server/g10-hold.ts`) is offered whether or not a reviewer MERGE is on record, since the
owner may release one at the terminal. Its read-back adds every verdict the PR's Shepherd timeline recorded, each
marked `atHead` when it names the live head, and counts the MERGEs at that head against the class's need: one for
`g10-review`, two from two reviewers for `g10-adversary`. When they fall short, the effect says so and
`confirmLabel` reads "Release without a MERGE" (or "Release without both MERGEs"). A verdict recorded after the
read changes the read-back, so the confirm is refused. The console calls Shepherd's `shepherd.release` on
loopback itself, naming the hold class and the confirmed head, with the actor
`owner-remote:titan-console action:<confirm>`. Shepherd refuses a moved head (the owner sees "PR moved"), and a
replay of a released confirm is answered `already` from its outcome file, without a second release.

## active-work reads

`server/active-work.ts` is the only code that calls the active-work daemon. It posts to
`/rpc/<command>` on loopback with a ten second timeout, and it can call only the reads in its
`READS` table: `list`, `task.list`, `inventory`, `session.list`, `loops` (offline, so a page
view never makes active-work call GitHub), `note.list`, `note.read`, `source.list`, `source.read`,
`search`, `artifact.list`, `artifact.status`, `context.graph` and `deliverable.list`
(active-work 0.23 on, read only for a task that names a deliverable). Each
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
| `#/` | Home | Upstream health, status counts, a read-only needs-you list and the last day's activity | TP-1061 |
| `#/initiatives` | Work | Initiative portfolio: cards by state, then record counts per initiative | TP-861 |
| `#/initiatives/<slug>` | Work | One initiative: header, open loops, brief, and tabs for open tasks, sessions, notes and sources | TP-861 |
| `#/tasks`, `#/tasks/<id>` | Tasks | Tasks grouped by derived stage, and task detail | TP-866a |
| `#/sessions`, `#/sessions/<id>` | Sessions | Sessions list, and one session with its conversation first | TP-862 |
| `#/agents`, `#/agents/<name>` | Agents | Roster, spawn tree and message feed, and one agent | TP-864a, TP-865a |
| `#/knowledge` | Notes | Browse tab: notes and sources in one table, filtered by `initiative`, `kind` and `since` in the query string. Search tab: hits by ref for `?tab=search&q=<q>`. The Graph tab is TP-1064 | TP-869 |
| `#/knowledge/<ref>` | Notes | One note or source as prose, with a link to its initiative | TP-869 |
| `#/rounds`, `#/rounds/<id>` | Rounds | Open and sent review rounds, and one round's questions with keys 1-9 choosing an option. A question round sends its picks and text through `rounds.submit` with Send answers, once its required questions hold an answer, and shows the sent state and its recommendations after; an owner-write refusal is shown as the server words it. A design round shows each section's frames as a labelled strip and its `seeAlso` frames as thumbnails, each tapped to open full size, and sends its answers the same way; an after-answer round shows its recommendations once sent. Without a valid `frames/frames.json` a design round points to the harness. A Ship round (a merge-bound question) shows each changed image as before, after and diff, light and dark side by side, loaded as it scrolls near and enlarged on a tap, and answers Ship (bound to the question's head sha) or Send back (with an optional note) through `rounds.submit`, then shows the factory's outcome. Above the answer one line names the proven-at sha, merged or UNMERGED, the base tip and `N behind`, a stale head badged, or `lineage unknown` with its reason. With no rounds the page names the rounds dir and `titan-console rounds import <round-dir>` | TP-1987 |
| `#/config` | Config | Every row `config.surfaces` reads, grouped by surface, after the `config.drift` rows whose copies disagree and those kept in step, and the `config.hosts` list: each other host's name and last report time, one silent for 25 hours marked "not reported". A row with a file line is `terminal`: it shows the exact command that opens that line, with a copy button. A hidden row (a secret or an undeclared key) shows only "present". The page has no edit control | TP-3640, TP-3643 |

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

## Twin captures

`pnpm --filter titan-console capture` builds the page and embeds a twin snapshot in it. It
then opens the page from disk in headless Chromium, with every request off disk refused, and
shoots each route in `server/twin/routes.ts` at phone (375x812) and desktop (1440x900) widths.
Each route is shot twice, in fresh contexts, and the command fails if the two PNGs differ by
one byte. `--out <dir>` writes somewhere other than `dist/twin`.

What it writes is what a console PR's visual review packet reads:

```
dist/twin/manifest.json          format titan-console-twin/v1: now, viewports, and per frame its route, hash, file and sha256
dist/twin/<viewport>/<route>.png phone/ and desktop/
dist/twin/<viewport>/<route>.second.png  only for a route whose two shots differed
```

What holds a frame still:

| Source of drift | How the twin pins it |
| --- | --- |
| Data | `server/twin/answers.ts` answers the broker, sessions, Shepherd, inbox, reviews, theater and task reads by hand. Each `answer()` is typed by the command's own args and result from `ConsoleCommands`, so a fixture that drifts fails `pnpm typecheck`. Work and rounds reads are the real commands over `server/fixtures.ts` and `fixtures/rounds`, recorded in process. |
| The clock | `Date` is frozen at 2031-03-05 12:00:30 UTC (`server/twin/clock.ts`) and `Math.random` is seeded; the server-side reads take the same clock. The second shot runs one second later, so a page that prints the clock fails. Ages to the minute do not move. |
| Fonts | react-ui imports its web fonts from Google Fonts, which the twin refuses, so text is set in the system sans. Frames are stable on one machine; another machine's sans may differ. |
| Motion and media | Reduced motion, animations stopped at the shot, the caret hidden, and a video's native controls hidden (their loading spinner never stops). |
| Locale and layout | UTC, `en-US`, device scale 1, dark colour scheme. Round fixtures are read from a copy with pinned mtimes. |

A new route goes in `TWIN_ROUTES`. `src/twin.test.tsx` fails until every call it makes has an
answer, and fails on an answer no route asks for.

## Layout

```
server/   config.ts (ports and paths), paths.ts (the built page and export locations),
          upstreams.ts (the three probes), active-work.ts (the read-only client), broker.ts (the
          read-only agent-chat broker client), factory.ts (the factory's needs.list client),
          approval-items.ts (spool and round queue items), approvals.ts (approvals.flow), work.ts
          (the work.* read models), agents.ts (the agents.* commands), commands.ts (the command list and `ConsoleCommands`), registry.ts,
          daemon.ts, cli.ts (the bin), dev.ts, export.ts, fixtures.ts (synthetic answers),
          test-support.ts (a fake daemon for tests), twin/ (the twin fixtures and capture)
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

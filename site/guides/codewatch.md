# Running the code report

`apps/codewatch` is a browser report over one code-graph snapshot: the big picture first,
then prioritised findings, then a drill-down into any directory, file or symbol. It composes
[`code-read`](/reference/code-read), [`rpc-client`](/reference/rpc-client) and
[`react-app`](/reference/react-app), with components from the separate `react-ui` design
system. The same build runs three ways: in development, served by a daemon, or as one HTML
file opened from disk.

The app is private and publishes nothing. Its scripts index this repository; they are a
worked example of the [front-end kit](/guides/package-families#the-front-end-kit), not a
general tool.

## Prerequisites

Node 20 or newer, pnpm 9, and git. The index script runs `git rev-parse` in the checkout.

## Build and first run

```sh
pnpm install --frozen-lockfile && pnpm build   # the workspace packages the scripts import
pnpm --filter codewatch index                  # index this repo into .codewatch/graph.db
pnpm --filter codewatch dev                    # Vite on :5173, read API daemon on :7433
```

`index` prints one line when it finishes:

```
indexed 1146 files, 9251 nodes, 17093 edges -> snapshot 1 in 204.9s (<repo>/.codewatch/graph.db)
```

Expect a few minutes. Each `index` run adds a snapshot; the report pins the newest.

## Commands

Run each from the repository root (`apps/codewatch/package.json`).

| Command | What it does |
| --- | --- |
| `pnpm --filter codewatch index` | indexes the repo into the graph database |
| `pnpm --filter codewatch dev` | starts the read API daemon and a Vite dev server that proxies `/rpc` to it |
| `pnpm --filter codewatch build` | builds the single-file app to `apps/codewatch/dist/index.html` |
| `pnpm --filter codewatch serve` | serves the built app and `/rpc` from one daemon on port 7433 |
| `pnpm --filter codewatch export` | writes `dist/report.html`, a self-contained report that needs no server |
| `pnpm --filter codewatch call <command> '<json args>'` | answers one read command in process and prints its size and time |
| `pnpm --filter codewatch fixtures` | rebuilds the two committed test fixtures from real indexes |

```sh
pnpm --filter codewatch call api.describe '{}'
pnpm --filter codewatch call findings.list '{}'
CODE_REPORT_PORT=7434 pnpm --filter codewatch serve
```

`serve` prints the address and answers until SIGINT or SIGTERM:

```
code report: http://127.0.0.1:7433/ (pid 4242)
```

The read commands are `api.describe`, `snapshot.list`, `hierarchy.get`, `node.get`,
`node.neighbors`, `node.resolve`, `findings.list` and `finding.get`. Over HTTP each is
`POST /rpc/<command>`, and a call needs an `Origin` or `X-Titan-Client` header.

`export` records the calls each page makes on first paint and embeds the snapshot's read
model, so paging, filters and search work offline. It then replays every recorded call
against the live registry and fails if an answer differs:

```
snapshot 1: recorded 4 calls; every other call is answered by the dataset resolver
<repo>/apps/codewatch/dist/report.html: 12802 KiB (open it from disk; no server needed)
live parity: 4 of 4 recorded answers match the live registry
```

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODE_REPORT_DB` | `<repo>/.codewatch/graph.db` | the graph database every script reads and `index` writes |
| `CODE_REPORT_PORT` | `7433` | the daemon port, and the port Vite proxies `/rpc` to |
| `CODE_REPORT_RULES` | `.codewatch/check.json` | the check rules whose violations are the findings; a path relative to the repo root |

Findings are derived on read from the check rules. CI keeps `.codewatch/check.json` at zero
violations, so the Priorities page is empty on a clean tree. Use the stricter demo rules to
see findings:

```sh
CODE_REPORT_RULES=apps/codewatch/rules/strict.json pnpm --filter codewatch dev
```

## Where state lives

| What | Where |
| --- | --- |
| Graph database | `CODE_REPORT_DB`; the default is gitignored |
| Built app and exports | `apps/codewatch/dist/` (`index.html`, `report.html`, `report-snapshot.json`) |
| Daemon pid file | `code-report-daemon-<port>/` under the system temp directory |
| Logs | stdout and stderr of the script; nothing is written to a log file |

## How it fails

| What you see | Why |
| --- | --- |
| `"newest": null` from `api.describe`, and an empty report | the database has no snapshot; run `index` |
| `… index.html is missing; run pnpm --filter codewatch build` | `serve` before `build`; the daemon serves a "not built" page until then |
| `Daemon already running (pid N, port P)` | another `dev` or `serve` holds the port's pid file |
| `export` exits non-zero after `live parity` | a recorded answer differs from the live registry |
| a page reports `not-in-export` | an exported report holds the text of flagged files only |
| the Compare page is a placeholder | identity across renames has not reached `code-read` yet |

The routes, the static export format, the fixture builder and the placeholder seams are
documented in
[`apps/codewatch/README.md`](https://github.com/HJewkes/titan-platform/blob/main/apps/codewatch/README.md).

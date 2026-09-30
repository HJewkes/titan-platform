# Running the factory

`titan-factory` runs software workflows whose transitions, retries and approvals are owned
by code. A run is a durable row in one SQLite file, a human decision is a gate in the same
file, and a crash resumes from the last completed step. Two workflows are registered today
(`products/factory/src/workflows.ts`):

- `land-pr` lands one pull request: wait for required checks, keep the branch current, ask a
  human, merge, run an optional chore.
- `shepherd-pr` watches a pull request, or a branch that has no pull request yet, and lands
  it under a per-repo policy. It has its own guide: [Shepherd](/guides/shepherd).

The factory never dispatches an agent. For the design and the file map, read the
[factory reference](/reference/factory) and
[`products/factory/README.md`](https://github.com/HJewkes/titan-platform/blob/main/products/factory/README.md).

## Prerequisites

- Node 20 or newer and pnpm 9.
- The GitHub CLI, logged in (`gh auth status`). The factory talks to GitHub by running
  `gh api` on your login and reads no token itself (`packages/github`).
- A base branch that requires at least one status check. `land` waits on required checks
  only, so it refuses a branch that requires none.
- macOS, only for `service install`, `status`, `restart` and `uninstall`, which drive
  launchd. Every other command, `service plist` included, runs anywhere Node does.

## Build

The product is private and is not on npm. Run it from a checkout:

```sh
git clone https://github.com/HJewkes/titan-platform
cd titan-platform
pnpm install --frozen-lockfile && pnpm build
node products/factory/dist/bin.js --help
```

The examples below write `titan-factory` for `node products/factory/dist/bin.js`. Rebuild
after every pull: the bin loads sibling packages from their `dist`.

To run it by that short name, put it on `PATH`:

```sh
pnpm factory:install
```

That installs, builds the factory with its workspace dependencies, and links
`~/.local/bin/titan-factory` to the built bin. The link survives a rebuild and needs no
sudo. It leaves a link that points at another checkout alone unless you add `--force`, and
`--bin-dir <dir>` picks another directory.

## Where state lives

| What | Where |
| --- | --- |
| Database | `--db <path>`, else `TITAN_FACTORY_DB`, else `dbPath` in the config file, else `$XDG_STATE_HOME/titan-factory/factory.sqlite3` |
| Config file | `$XDG_CONFIG_HOME/titan-factory/config.json` |
| Server lock | `daemon.pid` and `daemon.meta.json` in the database's directory, while `serve` runs |
| Logs | stderr when you run `serve` by hand; `$XDG_STATE_HOME/titan-factory/serve.out.log` and `serve.err.log` under launchd |

`XDG_STATE_HOME` defaults to `~/.local/state` and `XDG_CONFIG_HOME` to `~/.config`
(`products/factory/src/config.ts`). The database holds runs, gates and Shepherd
registrations. Nothing else is written.

## The config file

The file is optional. Every key is optional too. It holds owner-specific bindings, so it
stays out of the repo.

```json
{
  "dbPath": "/srv/titan-factory/factory.sqlite3",
  "postMerge": { "argv": ["/usr/local/bin/after-merge"], "cwd": "/srv/checkouts/repo", "timeoutMs": 600000 },
  "shepherd": {
    "seatsDir": "/srv/autonomy/seats",
    "charterPath": "/srv/autonomy/charter.md",
    "hardStopRepos": { "dotfiles-merge": ["owner/dotfiles"] }
  }
}
```

- `postMerge` is the chore `land-pr` runs after a merge. It runs `argv` with no shell, with
  `LAND_PR_REPO`, `LAND_PR_NUMBER` and `LAND_PR_MERGE_SHA` in its environment, and is killed
  after `timeoutMs` (default 10 minutes). An unknown key such as `shell` fails the load.
- `shepherd` is covered in the [Shepherd guide](/guides/shepherd#seat-policy).

A malformed file fails every command that opens the database, with
`invalid config <path>: <reason>`. `--help` and `service plist` still work
(`products/factory/src/bad-config.test.ts`).

## `serve`

```sh
titan-factory serve              # loopback port 7410
titan-factory serve --port 7411
```

`serve` owns the database until SIGTERM or SIGINT. It adopts every unfinished run at start,
and again every 30 seconds for runs whose owner died and whose lease lapsed. It binds
`127.0.0.1` and exposes three surfaces (`products/factory/src/serve.ts`):

| Route | What it answers |
| --- | --- |
| `GET /health` | run counts by status, pending gate count, the GitHub probe, version, pid, port |
| `POST /rpc/<command>` | one registry command; the body is its JSON arguments |
| `/mcp` | the same commands as MCP tools over streamable HTTP |

```sh
curl -s http://127.0.0.1:7410/health
```

```json
{"runs":{"running":2,"paused":0,"cancelling":0,"recovery_required":0,"completed":0,"failed":0,"cancelled":0},
 "pendingGates":0,"github":"ok","ok":true,"version":"0.1.0","pid":4242,"uptime_ms":4784,"port":7410}
```

`github` is `ok` when `gh api rate_limit` succeeds in the server's environment, the redacted
`gh` error when it fails, and `checking` before the first probe lands. The probe runs in the
background at most once a minute, so a health request never waits on `gh`.

The registry commands are `factory.land`, `factory.status`, `factory.gates`, and the seven
`shepherd.*` commands. A `/rpc` call needs an `Origin` header or an `X-Titan-Client` header;
without one the server answers 403.

```sh
curl -s -X POST http://127.0.0.1:7410/rpc/factory.status \
  -H 'content-type: application/json' -H 'x-titan-client: shell' -d '{}'
curl -s -X POST http://127.0.0.1:7410/rpc/factory.gates \
  -H 'content-type: application/json' -H 'x-titan-client: shell' -d '{}'
```

`factory.status` takes an optional `runId` and otherwise lists every unfinished run.
`factory.gates` lists each pending gate with its prompt, its schema, and the CLI command
that resolves it. The MCP tool names carry no prefix: `factory__land`, `factory__status`,
`factory__gates`, `shepherd__register`, and so on. To add the server to Claude Code:

```sh
claude mcp add --transport http --scope user titan-factory http://127.0.0.1:7410/mcp
```

No `/rpc` route and no MCP tool resolves a gate. `POST /rpc/gate.resolve` answers 404
`Unknown command`. That is deliberate: see [`gate resolve`](#gate-resolve).

## `land`

```sh
titan-factory land owner/repo#123
titan-factory land owner/repo#123 --task initiative/42 --port 7411
```

The reference must be exactly `owner/repo#N`. `land` first probes `/health` on `--port`
(default 7410). When a server answers, it posts `factory.land` and returns at once; the
server drives the run:

```
run 6269c75b-… land-pr owner/repo#123: running on titan-factory serve (port 7410)
```

When no server answers, `land` drives the run in this process until it ends or waits on a
gate, prints the gate, and exits. The run is then unowned until `serve` or `resume` picks it
up. Landing the same pull request twice returns the unfinished run instead of starting
another.

The steps, in order (`products/factory/src/workflows/land.ts` and `land-pr.ts`):

1. `snapshot` and `land-rules` read the pull request and the required checks of its base.
2. `ci-wait` polls every 30 seconds for up to 45 minutes, until every required check has
   finished. Only runs from GitHub Actions count.
3. `update-branch` runs when the branch is behind. After three updates the run opens the
   `stuck-behind` gate.
4. A red head opens the `ci-failed` gate. One exception: when every failure is a cancelled
   or timed-out Actions run, the code reruns it without asking, once per run.
5. A green head opens the `approve-merge` gate. `land-pr` holds no allow rule, so a human
   approves every merge.
6. `merge` squashes the exact approved head. A head anyone else pushed asks again.
7. `post-merge` runs the configured chore, if any, and records its exit code and output tail.

## `gate resolve` {#gate-resolve}

```sh
titan-factory gate resolve <runId> <stepId> --json '<payload>'
```

This verb is the only way to answer a gate, and it writes to the database directly. It is
never a network call, so no agent with MCP or HTTP access can approve its own merge. The
payload must match the schema stored with the gate:

| Gate | Payload |
| --- | --- |
| `approve-merge` | `{"decision":"merge","headSha":"<40 hex>"}` or `"abandon"` |
| `ci-failed` | `{"decision":"rerun","headSha":"<40 hex>"}`, `"abandon"` or `"await-fix"` |
| `stuck-behind` | `{"decision":"retry"}` or `"abandon"` |

`headSha` must be the head the prompt showed, so an approval never carries over to a head
you did not see. `resume` and `factory.gates` print the exact command for each open gate;
copy the run id and step id from there.

## `resume`

```sh
titan-factory resume
```

`resume` claims every unfinished run whose lease is free, drives each until it completes,
fails, parks, or waits on a gate, then releases the runs and lists the open gates. With
nothing to do it prints `nothing to resume`. It stays in the foreground while any run it
claimed is still waiting on CI or on a pull request to open; use `serve` for those.

A run that another process owns is reported, not touched:

```
held ab0f9228-… shepherd-pr: leased by 9fdfad86-… until 2026-09-30T14:42:43.078Z; retry after that
```

A killed process keeps its lease for 30 seconds. A run whose interrupted step may already
have had its effect (the post-merge chore) is parked as `recovery_required` for a human.

## Install as a service

On macOS, one verb installs `titan-factory serve` as the LaunchAgent
`dev.hjewkes.titan-factory`, so runs stay alive across shells and logins:

```sh
titan-factory service install          # add --mcp to register the MCP endpoint with Claude Code
titan-factory service install --port 7411 --mcp
```

`service install` does these in order:

1. Boots out the job when launchd already holds it, and waits until the label is gone.
2. Creates the log directory and writes
   `~/Library/LaunchAgents/dev.hjewkes.titan-factory.plist`.
3. Runs `launchctl bootstrap gui/<uid> <plist>`.
4. Polls `/health` for up to 30 seconds. The answer must come from the pid launchd reports
   for the job, so a `serve` you left running in a shell fails the install. On a timeout
   the verb prints the last 20 lines of `serve.err.log`.
5. With `--mcp`, runs `claude mcp add --transport http --scope user titan-factory
   http://127.0.0.1:<port>/mcp`. An already registered server counts as success. With no
   `claude` on `PATH`, or when the command fails, the verb prints the command to run by hand
   and still exits 0.

| Verb | What it does | Exits 0 when |
| --- | --- | --- |
| `service install [--port <n>] [--node <path>] [--mcp]` | The five steps above | the job answers `/health` with `github` `ok` |
| `service status [--port <n>]` | Prints loaded or not, the pid, and a `/health` summary | `/health` answers with `github` `ok` |
| `service restart [--port <n>]` | `launchctl kickstart -k`, then the same wait as install | the new process answers with `github` `ok` |
| `service uninstall` | Boots the job out when loaded, then removes the plist | the job is unloaded |

A server installed with `--port` needs the same `--port` on `status` and `restart`. On any
other platform these four verbs fail with one line.

### The job's `PATH`

launchd starts a job with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, and `serve` runs `gh`,
`agent-chat` and `claude` by bare name. The plist therefore sets one environment variable,
`PATH`: the directory each of those three is found in when the verb runs, then the directory
of the plist's node, then launchd's four, each once. Nothing else is copied from your shell.

A binary that is not found is left out and named in a `warning:` line. `service install`
refuses to run without `gh`. After you move one of these binaries, run `service install`
again.

### The GitHub check

`/health` carries a `github` field: `checking` until the first `gh api rate_limit` lands,
then `ok` or the redacted gh error. `install`, `restart` and `status` wait out `checking`
and exit 1 with one line when the field settles on anything but `ok`:

```
error: titan-factory serve answers on port 7410 but its GitHub check failed: gh api rate_limit failed (1): …
```

The job is still loaded at that point. A LaunchAgent may not reach the keychain token `gh`
uses in your shell; this check is how that shows. Fix the cause, then run
`titan-factory service restart`.

### `service plist`: the manual path

```sh
titan-factory service plist                                  # print to stdout
titan-factory service plist --port 7411 --node /usr/local/bin/node
```

The verb prints the same plist `service install` writes and changes nothing on disk. The
plist runs `<node> <checkout>/products/factory/dist/bin.js serve` with `RunAtLoad` and
`KeepAlive` true, `ProcessType` `Interactive`, and the `PATH` above. A Homebrew Cellar node
path is mapped to the stable prefix symlink so `brew upgrade` does not break the job;
`--node` takes any other absolute path (`products/factory/src/service.ts`).

To install it yourself:

```sh
titan-factory service plist > ~/Library/LaunchAgents/dev.hjewkes.titan-factory.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.hjewkes.titan-factory.plist
curl -s http://127.0.0.1:7410/health
```

The plist names the checkout it came from. After you move the checkout or change node, run
`service install` again, or print and bootstrap the plist again.

## How it fails

| What you see | Why |
| --- | --- |
| `error: Daemon already running (pid N, port P)` | a second `serve` on the same database directory; the first keeps serving |
| `error: invalid config <path>: …` | the config file is not valid JSON or has an unknown `postMerge` key |
| `error: expected owner/repo#N, got …`, exit 2 | a malformed reference; `#0` and `#01` are refused too |
| `error: gh api … failed (4): … gh auth login` | `gh` is not logged in where the command runs |
| `error: no gate with id <run>/<step>` | the run or step id is wrong, or the gate is already resolved |
| `error: --json must be a JSON object`, exit 2 | the gate payload did not parse as an object |
| a run `failed` with `ci-wait timed out after 2700000 ms` | required checks did not finish in 45 minutes |
| a run `failed` with `requires no status checks` | the base branch has no required check |
| `/health` shows `"github":"gh api rate_limit failed …"` | the server's environment cannot use `gh` |

Exit codes are 0 for success, 1 for a failure, and 2 for a usage error. A failed step stores
its error with `gh` token shapes and `Authorization:` values replaced and the text capped at
500 characters (`products/factory/src/redact.ts`).

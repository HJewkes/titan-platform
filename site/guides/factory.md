# Running the factory

`titan-factory` runs software workflows whose transitions, retries and approvals are owned
by code. A run is a durable row in one SQLite file, a human decision is a gate in the same
file, and a crash resumes from the last completed step. Two workflows are registered today
(`products/factory/src/workflows.ts`):

- `land-pr` lands one pull request: wait for required checks, keep the branch current, ask a
  human, merge, run an optional chore.
- `shepherd-pr` watches a pull request, or a branch that has no pull request yet, and lands
  it under a per-repo policy. It has its own guide: [Shepherd](/guides/shepherd).

The factory starts one kind of agent: the Shepherd reviewer, through agent-chat, and only
when `shepherd.review` is configured. Relay and agent-chat keep every other dispatch. For the design and the file map, read the
[factory reference](/reference/factory) and
[`products/factory/README.md`](https://github.com/HJewkes/titan-platform/blob/main/products/factory/README.md).

## Prerequisites

- Node 20 or newer and pnpm 9.
- The GitHub CLI, logged in (`gh auth status`). The factory talks to GitHub by running
  `gh api` on your login and reads no token itself (`packages/github`).
- A base branch that requires at least one status check. `land` waits on required checks
  only, so it refuses a branch that requires none.
- macOS or Linux, only for `service install`, `status`, `restart`, `uninstall`, `deploy` and
  `check`, which drive or read launchd or a systemd --user unit. Every other
  command, `service plist` included, runs anywhere Node does.

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
| Logs | stderr when you run `serve` by hand; `$XDG_STATE_HOME/titan-factory/serve.out.log` and `serve.err.log` under launchd or systemd. Each stderr line starts with its ISO time |

`XDG_STATE_HOME` defaults to `~/.local/state` and `XDG_CONFIG_HOME` to `~/.config`
(`products/factory/src/config.ts`). The database holds runs, gates and Shepherd
registrations. Nothing else is written.

A failed Shepherd run's `workflow_run.error` starts with its failure class, one of
`[ci-timeout]`, `[gh-api-5xx]`, `[land-rules]`, `[update-branch]` or `[other]`.
`titan-factory shepherd stats --failures` counts failed runs by class per repo and ISO week, and
classifies older rows without the prefix from their text. See [Stats](/guides/shepherd#stats).

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
    "hardStopRepos": { "dotfiles-merge": ["owner/dotfiles"] },
    "agentChatBin": "/usr/local/bin/agent-chat",
    "review": {
      "profile": "rv-readonly",
      "configDir": "<agent-home>/.claude-profiles/rv",
      "verdictTimeoutMs": 1800000,
      "sessionStartTimeoutMs": 300000
    },
    "fixer": { "configDir": "<agent-home>/.claude-profiles/fixer" }
  }
}
```

- `postMerge` is the chore `land-pr` runs after a merge. It runs `argv` with no shell, with
  `LAND_PR_REPO`, `LAND_PR_NUMBER` and `LAND_PR_MERGE_SHA` in its environment, and is killed
  after `timeoutMs` (default 10 minutes). When GitHub reports the PR merged but names no merge
  commit, the merged outcome's `mergeSha` is `null`, and `LAND_PR_MERGE_SHA` is left unset, even
  when the factory's own environment has one. A chore that needs the sha should check that it is set. An unknown key such as `shell` fails the load.
- `shepherd.agentChatBin` is the absolute path of the `agent-chat` executable. It is required
  when `shepherd.review` or `shepherd.fixer` is set. Without it, a red main still freezes the
  repo and files a fix task, but spawns no fixer.
- `shepherd.review` turns the review phase on. `profile` is the one agent-chat profile the
  reviewer is spawned with. `configDir` is optional: an absolute path to the reviewer's Claude
  config directory, under the agent's home. `config.ts` checks only that the path is absolute;
  agent-chat refuses a config directory outside the home. The two timeouts are optional (30 minutes for the
  verdict, 5 minutes for the session start). With no `review` key no reviewer is started and
  the owner decides every merge. A `review` block without `agentChatBin`, or an unknown key in
  it, fails the load. The full key table is in the
  [factory README](https://github.com/HJewkes/titan-platform/blob/main/products/factory/README.md#shepherd-reviewer-config).
- `shepherd.fixer` tunes the fixer a red main spawns (see
  [After the merge](/guides/shepherd#after-the-merge)). Its one key, `configDir`, is optional
  and follows the same rules as `review.configDir`. A `fixer` block without `agentChatBin`
  fails the load with `fixer needs an agentChatBin`, and so does an unknown key in it.
- `shepherd.spawnGate` overrides the load gate every factory spawn passes: reviewers, fixers
  and successors share it. It refuses above `load5` (28), `buildLoad5` (20, with `reviewLoad`
  4 added per review started in the last five minutes), at memory `pressureLevel` 2, and under
  `freeMemoryPct` 20. Admits are spaced `windowMs` (60 s) apart. While the machine has headroom
  (load5 under half of `buildLoad5`, memory pressure read as normal, and fewer than
  `headroomReviews` (4) reviews started in the last five minutes) they are spaced
  `headroomIntervalMs` (15 s) apart instead. At most `burstMax` (4) are admitted inside any
  `windowMs`. Every deferral names the rule that refused. A deferred review asks again on its
  busy wait, which doubles from 1 to 8 minutes. That waiting counts against the 3 hour
  machine-hold ceiling, not the reviewer's 30 minute busy budget, so a backlog drains instead
  of recording `none`.
- The rest of `shepherd` is covered in the [Shepherd guide](/guides/shepherd#seat-policy).

A malformed file fails every command that opens the database, with
`invalid config <path>: <reason>`. `--help` and `service plist` still work
(`products/factory/src/bad-config.test.ts`).

## `serve`

```sh
titan-factory serve              # loopback port 7410
titan-factory serve --port 7411
```

`serve` owns the database until SIGTERM or SIGINT. It adopts every unfinished run at start,
and again every 30 seconds for runs whose owner died and whose lease lapsed. Its 5-minute
Shepherd sweep also marks a merged run `sh-reverted` when a later main commit reverts its merge
(see [Shepherd stats](./shepherd.md#stats)). It binds
`127.0.0.1` and exposes these surfaces (`products/factory/src/serve.ts`):

| Route | What it answers |
| --- | --- |
| `GET /health` | run counts by status, pending gate count, the busy runs, the GitHub probe, `build` (sha and whether it is behind main), `lastDeploy`, `deploy` (the deploy alarm, when serve runs it), `ownerKeys` (the loaded owner key ids, or why none loaded), `startedAt`, `uptimeSeconds`, the start counts `restartCount`, `uncleanStartsTotal` (starts that found a stale pid file) and `restartsToday` (UTC), kept in `serve-starts.json` in the state directory, version, pid, port |
| `POST /rpc/<command>` | one registry command; the body is its JSON arguments |
| `POST /gates/resolve-proof` | applies an owner-signed proof and returns each item's outcome; see [Owner-signed proofs](#owner-signed-proofs) |
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

The registry commands are `factory.land`, `factory.status`, `factory.gates`, `needs.list`,
`needs.count`, and the seven `shepherd.*` commands. A `/rpc` call needs an `Origin` header or an `X-Titan-Client` header;
without one the server answers 403.

```sh
curl -s -X POST http://127.0.0.1:7410/rpc/factory.status \
  -H 'content-type: application/json' -H 'x-titan-client: shell' -d '{}'
curl -s -X POST http://127.0.0.1:7410/rpc/factory.gates \
  -H 'content-type: application/json' -H 'x-titan-client: shell' -d '{}'
```

`factory.status` takes an optional `runId` and otherwise lists every unfinished run.
`factory.gates` lists each pending gate with its prompt, its schema, and the CLI command
that resolves it.

`needs.list` returns `{ items, gaps }`. `items` is the merged OwnerItem[] that
`titan-factory needs --json` prints: agent-chat, factory gates, Morning queues and
needs-decision tasks, with duplicates folded. `gaps` names each source that could not be
read, so an outage never looks like an empty queue. `needs.count` returns `total`, `byKind`,
`byLens` and `gaps` for the same set. Both take the same optional filters:

- `kind`: `decide`, `approve`, `do`, `review` or `know`.
- `lens`: `blocking-agent`, `blocking-merge`, `stuck`, `planning` or `fyi`.
- `initiative`: an initiative slug.
- `personal`: `true` to include personal initiatives, which are otherwise left out.

```sh
curl -s -X POST http://127.0.0.1:7410/rpc/needs.list \
  -H 'content-type: application/json' -H 'x-titan-client: shell' -d '{"kind":"approve"}'
curl -s -X POST http://127.0.0.1:7410/rpc/needs.count \
  -H 'content-type: application/json' -H 'x-titan-client: shell' -d '{}'
```

A permission prompt or endorsement from agent-chat is always a one-way `approve` item whose
source names the broker's msg_id; nothing reshapes it into a decision.

The MCP tool names carry no prefix: `factory__land`, `factory__status`,
`factory__gates`, `needs__list`, `shepherd__register`, and so on. To add the server to Claude Code:

```sh
claude mcp add --transport http --scope user titan-factory http://127.0.0.1:7410/mcp
```

That registers the profile you run it under. Agents on another Claude profile need their own
registration: `titan-factory service install --mcp --claude-config-dir <dir>` (repeatable) registers
the endpoint in each dir and prints the config file it wrote.

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

## Owner-signed proofs {#owner-signed-proofs}

The factory host can apply a gate answer the owner signed on another machine. One signature can
cover one gate, or a batch of merge gates. `serve` receives proofs on `POST /gates/resolve-proof`, and
`applyProof` is the core behind it. The Mac client that signs comes in a later slice. The flow:

1. The signature is checked over the exact statement bytes, then the key, the time window, the
   audience and the digest of the items.
2. A nonce that was already used is refused, and nothing is resolved.
3. Each item is checked against its live gate. In a batch, only plain merge gates answered `merge`
   at the listed head may ride. Release gates (`shepherd-release` merges and `after-stages`) and
   hardware gates stay one per proof.
4. The proof is recorded, with its statement and signature, before any item fires.
5. Each item fires only while its gate is still pending at the listed head, and, with a GitHub
   port, while the PR is open at that head. An item that moved or closed is skipped and named.
6. A resolved gate records the resolver `owner-terminal` `key:<keyId>`, channel
   `factory-proof`. A failed resolve stops the batch, and the record shows which items fired.

The package README has the record's columns and the exact checks.

### The route and the owner keys

The route takes `{"statement": <base64url bytes>, "signature": <base64url DER>}` and answers
`{ok, batchId, items: [{gate, outcome, detail?}]}`. A one-item proof is a single `gate resolve`.
It is not an MCP tool or an RPC command, and it sits behind the same Host, Origin and
client-header guards as `/rpc`. Bodies over 512 KiB get 413. A refused proof gets 403, or 409
for a replay, and resolves nothing. Logs name the refusal or the outcomes, never the proof.

The owner public keys load once at start from `/etc/titan-factory/owner-keys/*.pem`. The path is
fixed in code. The directory, each of its parents and each key file must be owned by root, carry no
group or other write bit, and not be a symlink. Any failure refuses the whole set. `/health` then
shows `ownerKeys: {count: 0, refusal}` and the route answers 503 `owner keys not installed`.
`factory.gates` returns `aud`, the host name a proof must be signed for.

Install a key on the factory host, then restart serve:

```sh
sudo install -d -o root -g root -m 0755 /etc/titan-factory /etc/titan-factory/owner-keys
sudo install -o root -g root -m 0644 owner-presence.pub.pem /etc/titan-factory/owner-keys/mac.pem
titan-factory service restart
curl -s http://127.0.0.1:7410/health | jq .ownerKeys
```

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

## `digest run`

```sh
titan-factory digest run --dry-run   # print the owner digest for the current slot
titan-factory digest run             # write <date>-<HH>.md to the digest dir and the iCloud dir
```

The digest covers every seat in the seat book in under 400 words: Needs you, Merged, Stuck,
Seats and Spend. A source that cannot be read becomes a Gaps line instead of a failure. The
`digest` config block and the sources are in the package README, under "Owner digest".

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
   the verb prints the path of `serve.err.log` and a `tail -n 20` command for it, never the
   log's lines, since a post-merge chore stores this output. The wait covers
   [the GitHub check](#the-github-check): a `github` field that settles on anything but
   `ok` fails the install with one line.
5. With `--mcp`, runs `claude mcp add --transport http --scope user titan-factory
   http://127.0.0.1:<port>/mcp`. An already registered server counts as success. With no
   `claude` on `PATH`, or when the command fails, the verb prints the command to run by hand
   and still exits 0.

| Verb | What it does | Exits 0 when |
| --- | --- | --- |
| `service install [--port <n>] [--node <path>] [--mcp]` | The five steps above | the job answers `/health` with `github` `ok` |
| `service status [--port <n>]` | Prints loaded or not, the pid, and a `/health` summary | `/health` answers with `github` `ok` |
| `service check [--port <n>] [--json]` | Read-only diagnosis: one line naming the first cause that holds (`not loaded`, `stale pid`, `crash loop`, `stale build`, `GitHub down`); `--json` adds `cause`, `pid`, `health` and `detail` | `/health` answers from the launchd or systemd pid with `github` `ok` |
| `service restart [--port <n>] [--drain-timeout <d>] [--no-drain] [--force]` | Waits until `/health` lists no busy run, then `launchctl kickstart -k`, then the same wait as install | the new process answers with `github` `ok` |
| `service deploy [--expect <sha>]` | Fast-forwards the service checkout, rebuilds the factory when the range touches it, restarts drained; see [below](#service-deploy-redeploy-from-main) | the target is deployed, already deployed, or skipped as untouched |
| `service uninstall` | Boots the job out when loaded, then removes the plist | the job is unloaded |

On Linux the same verbs manage the systemd --user unit `titan-factory.service` in
`$XDG_CONFIG_HOME/systemd/user/`, else `~/.config/systemd/user/`. The unit runs the plist's
argv with `Restart=always`, the plist's `PATH` and its two log files, and is enabled under
`default.target`. Install runs `daemon-reload` and `enable --now` (plus `restart` when the unit
was already running), then the same `/health` wait. `service install --dry-run` prints the file
and the calls it would make, and changes nothing. Run `loginctl enable-linger "$USER"` once so
the unit runs without a login session. The package README maps each plist key to its unit line.

`service check` defines each cause precisely and reports the first that holds, in this order:

On Linux it reads `systemctl --user show titan-factory.service` instead: `MainPID` is the pid
(none unless `ActiveState` is `active`), `NRestarts` stands in for the run count and
`ExecMainStatus` for the last exit code.

- **not loaded**: `launchctl print` finds no `dev.hjewkes.titan-factory` job, or the unit's `LoadState` is not `loaded`.
- **stale pid**: launchd's pid is dead, a different pid answers `/health` on the port, or launchd holds no process or one that gives no `/health` answer (and it is not crash-looping).
- **crash loop**: launchd's last exit code is non-zero, the job has started at least 3 times, and it holds no process or its process started under 5 minutes ago and does not answer `/health` itself. `service restart` and `launchctl kickstart -k` leave a non-zero last exit and bump the run count, so a young process whose `/health` body names the launchd pid is a restart, not a crash loop.
- **stale build**: the build sha in `/health` differs from the sha baked into the installed dist; an `unknown` sha on either side never counts.
- **GitHub down**: the right pid answers but `github` is not `ok`.

It never starts, stops or restarts the job.

`service check` exits with:

| Code | Meaning |
| --- | --- |
| `0` | `/health` answers from the launchd or systemd pid with `github` `ok`, and the build is not stale |
| `1` | One of the causes above holds, or the platform is neither macOS nor Linux |
| `2` | Usage error, such as an invalid `--port` |

A server installed with `--port` needs the same `--port` on `status` and `restart`. On any
other platform these four verbs fail with one line.

`service restart` drains first. It polls `/health` every 5 s until its `busy` list is
empty, and prints the busy runs once a minute. A run is busy when it is `running` and its
current step is in Shepherd's `review` or `merging` phase (`sh-await-verdict` included), or
its step's route has `onRestart: "park"`. When `--drain-timeout` passes (default `45m`), the
restart goes ahead, because every Shepherd step repeats safely. A park-routed step that is still
busy refuses the restart instead, because the restart would leave its run `recovery_required`;
`--force` restarts anyway. A run in a merge step whose Shepherd hold is active and not yet
satisfied is not busy: it cannot merge until release, so a restart repeats nothing. `/health`
lists it under `heldSkipped`, and the drain names it. A hold its reviewer has satisfied, a
held run in a review step, a park-routed step, and a hold that cannot be read all stay busy.
`--no-drain` checks `/health` once and does not wait. A service
that does not answer, or a build from before `busy`, has nothing to drain.

### `service deploy`: redeploy from main

```sh
titan-factory service deploy                    # deploy origin/main
titan-factory service deploy --expect <sha>     # deploy one commit already on origin/main
```

`service deploy [--expect <sha>]` rebuilds and restarts the service from the checkout the bin
was built in, which must be on `main` with no tracked changes. It takes the pid lock
`$XDG_STATE_HOME/titan-factory/deploy.lock`. A lock whose pid is dead is stale; a deployer
takes it over by renaming it, so two deployers cannot both win, and on exit removes the lock
only while it still holds its own pid. It runs `git fetch origin main` and targets `--expect`
or `origin/main`; a target not on `origin/main` is refused. A target the running build
(`/health` `build.sha`) already contains is a no-op. A target behind the checkout's own `main`
is refused with the commit to deploy instead. It then diffs the running build sha to the
target against the factory closure, the workspace packages
`pnpm --filter "@titan-design/factory..."` selects, plus the root build inputs
(`pnpm-lock.yaml`, `package.json`, `pnpm-workspace.yaml`, `.npmrc`, root `tsconfig*.json`). An
unknown or dirty build sha counts as touched. When nothing intersects it runs
`git merge --ff-only` and records `skipped`.

A touched range whose `pnpm-lock.yaml` changes the version of a package with a native build
(`better-sqlite3`, the one in the factory closure) is refused before anything changes. The
deployer installs under `@titan-design/worktree`'s `setupEnv` pin, whose `ignore_scripts`
skips that package's compile, and a rollback restores `dist` only, never `node_modules`. The
refusal names the package and its versions and lists the steps to deploy it by hand.

Otherwise it copies every closure package's `dist` to `deploy-backup/<running sha>/`,
fast-forwards, runs `pnpm install --frozen-lockfile` under the `setupEnv` pin, builds the
closure, and restarts drained as `service restart` does. Success means launchd's pid answers
`/health` with `github` `ok`, and then `build.sha` equals the target. The sha read polls
`/health` up to 10 times with a 5 s timeout each, so a slow answer under load is not a
failure; only a wrong sha, or no sha in the whole poll, fails. A failed install or build
restores the snapshot and leaves the old process running, untouched. A failed restart or sha
check restores the snapshot and kickstarts again. Both record `rolled-back`, and that sha is
then held until a newer one arrives.

`deployed`, `skipped` and `rolled-back` go to `deploy.json`, which `/health` shows as
`lastDeploy`. A refusal is printed on stderr and never written, so it cannot clear a hold.
The deployer never runs `git reset`: a rollback reverts `dist` and leaves the checkout at the
target.

`serve` watches those refusals. Every five minutes it re-reads the tail of `redeploy.log`.
It judges the deployer only on what it was asked to land: each `service deploy --expect`
line there is an ask, and Shepherd writes one only after a merge's main CI is green. A
deploy lands exactly the sha it was asked for, so a landing (`deployed`, `skipped` or
`already deployed`) covers an earlier ask only when it names that ask's target or a target
asked at or after it. A burst's deployers that lose `deploy.lock` stay behind until something
newer lands. The running build is a landing too, so a deploy fixed by hand clears the alarm:
it lands its own ask, which covers that ask and every one before it and ends the refusals in
a row. A running build that no ask named lands nothing.
`/health` carries a `deploy` block: the running sha, the asks that have not landed
(`behind`, counting only asks older than 20 minutes) and the age of the oldest one, the
refusals in a row, and the last refusal's reason. The alarm goes up on two refusals in a row,
on more than 3 waiting asks, or on an ask over 60 minutes old. A merge that never asked, such
as one with a red main, raises nothing. A refusal because the checkout already landed a newer
commit from origin/main is a deploy finishing out of order, and does not count. When the last
refusal names `index.lock`, its reason ends with a report on the service checkout's
`.git/index.lock`: its path and age, and whether a process holds it. A lock with no holder that
is older than 10 minutes is reported as stale. `shepherd status` ends with a `deploy:` line.
`shepherd status --json --deploy` prints `{ rows, deploy }`; plain `--json` prints the bare
row array, as before. With `shepherd.hubSeat` and `shepherd.agentChatBin` set, the hub seat
gets one agent-chat message when the alarm goes up. It gets no second message until the alarm
clears. A failed message is retried on the next check.

It takes the same `--port`, `--drain-timeout`, `--no-drain` and `--force` as `service restart`.
It exits 1 on a refusal, a held sha, a lock held by a live deployer, or a rollback. The
refusal names its cause, such as `deploy refused: checkout not clean main: HEAD is feature/x,
not main`. A rollback cannot undo a `node_modules` change that the old `dist` cannot load.
The native-build refusal closes the known case. Any other such change leaves the service down
until a fix merges, and `lastDeploy.why` then ends with "the restored build did not answer
/health".

### The job's `PATH`

launchd starts a job with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, and `serve` runs `gh`,
`agent-chat` and `claude` by bare name. The plist therefore sets one environment variable,
`PATH`: the directory each of those three is found in when the verb runs, then the directory
of the plist's node, then launchd's four, each once. Nothing else is copied from your shell.
A directory with a `:` in its name is refused, `--node` included.

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
| `error: invalid config <path>: …` | the config file is not valid JSON, has an unknown `postMerge`, `shepherd.review` or `shepherd.fixer` key, or sets `review` or `fixer` without `agentChatBin` |
| `error: expected owner/repo#N, got …`, exit 2 | a malformed reference; `#0` and `#01` are refused too |
| `error: gh api … failed (4): … gh auth login` | `gh` is not logged in where the command runs |
| `error: no gate with id <run>/<step>` | the run or step id is wrong |
| `error: gate <id> is already <status>` | the gate was answered or cancelled before; `<status>` is `resolved` or `cancelled` |
| `error: --json must be a JSON object`, exit 2 | the gate payload did not parse as an object |
| a run `failed` with `ci-wait timed out after 2700000 ms` | required checks did not finish in 45 minutes |
| a run `failed` with `requires no status checks` | the base branch has no required check |
| `/health` shows `"github":"gh api rate_limit failed …"` | the server's environment cannot use `gh` |

Exit codes are 0 for success, 1 for a failure, and 2 for a usage error. A failed step stores
its error with `gh` token shapes and `Authorization:` values replaced and the text capped at
500 characters (`products/factory/src/redact.ts`).

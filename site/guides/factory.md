# Running the factory

`titan-factory` runs software workflows whose transitions, retries and approvals are owned
by code. A run is a durable row in one SQLite file, a human decision is a gate in the same
file, and a crash resumes from the last completed step. Two workflows are registered today
(`products/factory/src/workflows.ts`):

- `land-pr` lands one pull request: wait for required checks, keep the branch current, ask a
  human, merge, run an optional chore.
- `shepherd-pr` watches a pull request, or a branch that has no pull request yet, and lands
  it under a per-repo policy. It has its own guide: [Shepherd](/guides/shepherd).
  `shepherd stats --cost` reports what its review costs, in dollars and tokens per merged
  PR: see [Review cost](/guides/shepherd#review-cost).
  `shepherd stats --slo` checks it against the SLOs in `metrics/shepherd.yml`: see
  [SLOs](/guides/shepherd#slo).

The factory starts two kinds of agent through agent-chat: the Shepherd reviewer, only when
`shepherd.review` is configured, and the fixer a red main spawns, only when `shepherd.fixer` is.
Relay and agent-chat keep every other dispatch. For the design and the file map, read the
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
    "fixer": { "configDir": "<agent-home>/.claude-profiles/fixer" },
    "repos": { "acme/widgets": { "path": "/srv/checkouts/widgets", "advisory": true } }
  }
}
```

- `postMerge` is the chore `land-pr` runs after a merge. It runs `argv` with no shell, with
  `LAND_PR_REPO`, `LAND_PR_NUMBER` and `LAND_PR_MERGE_SHA` in its environment, and is killed
  after `timeoutMs` (default 10 minutes). When GitHub reports the PR merged but names no merge
  commit, the merged outcome's `mergeSha` is `null`, and `LAND_PR_MERGE_SHA` is left unset, even
  when the factory's own environment has one. A chore that needs the sha should check that it is set. An unknown key such as `shell` fails the load.

  The chore runs in its own transient unit (`systemd-run --user`, a detached process off Linux)
  and writes its result under `<stateDir>/chores`, so a restart of serve neither kills it nor
  loses its result. Under systemd it sees the user manager's environment plus serve's `PATH`,
  not the whole of serve's environment.
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
  fails the load with `fixer needs an agentChatBin`, and so does an unknown key in it. A red
  main's fixer and a fix-round successor start on `configDir` (or `review.configDir` when it is absent) and moves
  through `review.fallbackConfigDirs` while that account is out of usage. There is no
  `fixer.fallbackConfigDirs` (see [Shepherd](/guides/shepherd)).
- `shepherd.spawnGate` overrides the load gate every factory spawn passes: reviewers, fixers
  and successors share it. It refuses above `load5` (28), `buildLoad5` (20, with `reviewLoad`
  0.05 added per review started in the last five minutes, or admitted and not yet seen running),
  with fewer than `minIdleCores` (1) idle, read as the core count less load1 less those reviews,
  at memory `pressureLevel` 2, and under `freeMemoryPct` 20. `reviewLoad` is measured: reviewers
  run no tests and each claude process used 1 to 3 percent of a core in a 2026-10-29 sample, so
  `review.maxConcurrent` is the backstop on how many start. Load is the only limiter by
  default: `windowMs` and `headroomIntervalMs` are 0, and either can be raised live to space
  admits that many ms apart (`headroomIntervalMs` while load5 is under half of `buildLoad5`,
  memory pressure reads normal and fewer than `headroomReviews` (4) reviews are unabsorbed).
  `burstMax` is gone and fails the load. Every deferral names the rule that refused. When the
  gate admits a review, any asker within the first N of the queue goes, where N is the free
  review slots the load check also allows. A queued ask whose PR moved to a new head, merged or
  closed, by the open list another poll already read, leaves the queue and its review step ends
  with no reviewer. Reviews queue once and never ask again on their own: the gate starts them
  from the queue's front when one is queued, when a review ends, and on a one-minute tick while
  any waits. A review still queued after the 3 hour machine-hold ceiling gives up, so a
  saturated machine reaches the owner instead of waiting without end. A run cancelled or shut
  down while its review waits takes the review out of the queue at once, so it never starts.
  A reviewer also waits while `shepherd.review.maxConcurrent` (3) reviewers run, while the
  filesystem holding review checkouts has under `shepherd.review.minFreeBytes` (5 GiB) free, or
  while its free inodes are under `shepherd.review.minFreeInodesPct` (15) percent or twice the
  last checkout's inodes, whichever is more. Each such deferral keeps the review's place in the
  queue.
- `shepherd.repos` maps an `owner/name` repo to `path`, its main checkout, `advisory` and
  `stackRestack`. All three keys are optional, and an unknown one fails the load. Keys match in any case. The
  reviewer starts in `path` when no seat binds the repo, so Shepherd can review with no
  `seatsDir` at all. A seat's own path for the repo wins. The map is re-read on every
  spawn, as the seat book is.
- `advisory: true` makes Shepherd review, watch CI and notify on that repo, but never merge,
  update the branch, push to it or delete its head ref. The run waits held at its merge
  step, or at `update-branch` when the PR is behind on a strict repo. A wake still resumes or
  messages the PR's own implementer, but never spawns a successor, and a red main never
  spawns a fixer. Clear the flag and the
  held run merges on its next poll. Under the hold, the GitHub port itself refuses every
  merge, branch update, empty-commit push and ref delete for the repo, whatever route asks.
  The flag fails closed: the serve process reads it at start and on every check, and only
  a config file that loads cleanly and leaves it off clears it. A file that is missing, half written or invalid
  keeps the repo advisory, but only if this serve process has already read the flag. A serve
  that starts while the file is missing has no flag to keep, and treats every repo as not
  advisory until the file reads cleanly. If two keys differ only in case, the repo is advisory when
  either sets the flag.
- `stackRestack: true` opts the repo in to the stack restack (TP-2528). After Shepherd's own
  squash merge of a PR, each open `agent-chat/*` PR based on its head branch gets a merge-onto
  commit by a plain fast-forward push, and only then is retargeted to the default branch. It is
  off when absent, when the file is missing or invalid, and in an advisory repo. While it is off,
  `sh-stack-children` records `skipped` and nothing is pushed. A failed read of the open PRs
  also records `skipped`, so main CI and cleanup still run. Whatever the switch, `sh-cleanup`
  moves each open PR still based on the merged head branch onto that PR's base before it deletes
  the branch, and records them as `retargeted`. GitHub closes every open PR based on a branch
  deleted through the API (TP-3277). Cleanup lists the open PRs again just before the delete,
  and keeps the branch with a caveat while any of them is still based on it.
- `shepherd.redSeat` says where serve's [main CI watch](/guides/shepherd#main-ci-watch) sends a
  red-main event: `{ "repos": { "acme/widgets": "widgets-coord" }, "fallback": "ops-coord" }`.
  The repo's entry wins (keys match in any case), then `fallback`, and either one wins over the
  run's seat, the branch-prefix seat and `shepherd.hubSeat`. Both keys are optional. Only red
  events read it: merge grants, merge policy and the seat a run records stay with the seat
  file. It needs `agentChatBin`, and an unknown key in it fails the load.
- The rest of `shepherd` is covered in the [Shepherd guide](/guides/shepherd#seat-policy).

### GitHub event sources {#github-event-sources}

The `github` block, at the top level of the file and not under `shepherd`, chooses where GitHub events come from. Every key is
optional, and an unknown key fails the load.

```json
{ "github": { "sources": "polling", "ingress": "off", "pollingIntervalMs": 60000, "backstopIntervalMs": 300000 } }
```

| Key | Values | Default | What it does |
| --- | --- | --- | --- |
| `sources` | `"polling"`, `"webhook"` | `"polling"` | The mode the deployment is configured for |
| `ingress` | `"on"`, `"off"` | `"off"` | The kill switch for the [webhook ingress](#webhook-ingress) |
| `pollingIntervalMs` | integer, 30000 to 600000 | 60000 | The reconciler's cadence while the effective mode is polling |
| `backstopIntervalMs` | integer, 300000 to 600000 | 300000 | The reconciler's cadence while the effective mode is webhook |

The load fails when `pollingIntervalMs` exceeds `backstopIntervalMs`, and when `ingress` is `"on"` with `sources` `"polling"`
(under polling the route answers 404, so the combination can only be a mistake).

**Polling is a permanent, supported configuration.** It is the right choice for a deployment that does not want to expose a
webhook route, and it is the default. It is not a fallback that webhooks are meant to replace (389(6)). Webhook mode adds a
low-latency path for deployments that want one, and the reconciler stays on as its backstop.

The effective mode is what actually runs. It follows from the two switches:

| `sources` | `ingress` | Effective mode | Reason | Reconciler cadence |
| --- | --- | --- | --- | --- |
| `polling` | `off` | polling | `configured` | `pollingIntervalMs` |
| `webhook` | `off` | polling | `kill-switch` | `pollingIntervalMs` |
| `webhook` | `on` | webhook | `configured` | `backstopIntervalMs` |

The cadence keys are `github.pollingIntervalMs` and `github.backstopIntervalMs`, and they are the only ones. The reconciler has no
interval of its own (see [Reconciler](#reconciler)).

**The kill switch needs no restart.** Serve re-reads the config file whenever health or the schedule asks. To drop a webhook
deployment back to polling, set `github.ingress` to `"off"` and save: the next ingress request gets `404 {"error":"ingress off"}`
and the next tick runs at `pollingIntervalMs`. Set it back to `"on"` to return. A half-saved or invalid edit keeps the last good
value and reports the error in `health.sources.configError`, so a typo never turns a webhook deployment into a polling one. A file
that is invalid at start fails the start.

**What health reports.** `GET /health` carries a `sources` object:

| Field | Meaning |
| --- | --- |
| `configured` | `sources` as written in the file |
| `effective` | `polling` or `webhook`, as the table above resolves it |
| `reason` | `configured`, or `kill-switch` when a webhook deployment runs as polling |
| `intervalMs` | The cadence in force for the effective mode |
| `lastPassAt` | ISO time the reconciler last completed a pass, or `null` before the first completed pass (tp#2090). A pass that threw never stamps, so a stamp that keeps ageing is the sign of a stalled reconciler |
| `configError` | Present only while the file on disk is invalid |

**Going live with webhooks.** The polling-first gate (F11, TP-3103) is the order webhooks go live in: run on polling for the
48 hours first, then register the webhooks and flip `ingress`. It sequences a move to webhook mode and is not a reason polling
exists. The clocks are in [F11 gate](#f11-gate); the owner steps, Funnel route and rollback are in
[Webhook ingress](#webhook-ingress).

A malformed file fails every command that opens the database, with
`invalid config <path>: <reason>`. `--help` and `service plist` still work
(`products/factory/src/bad-config.test.ts`).

## Reconciler

The reconciler is the GitHub backstop (`products/factory/src/reconciler/`). Webhooks get
lost and GitHub does not redeliver them, so on a timer it reads each watched repo and appends
what it sees to the event log with `source: backstop`. It only appends. It never reads the log
back, never acts on a row, and never updates or deletes one.

```json
{ "reconciler": { "enabled": false, "fullEvery": 3, "repos": ["acme/widgets"] } }
```

- `enabled` is off by default. Serve starts no reconciler until it is on and the bot's
  GitHub port is wired (TP-3431). Turning it off stops every tick and the start pass.
- The tick period comes from the [`github` block](#github-event-sources):
  `pollingIntervalMs` under effective polling, `backstopIntervalMs` (5 to 10 minutes) under
  effective webhook. `reconciler.intervalMs` is deprecated and ignored. For one release the
  load still accepts it, so a config that sets it keeps starting, and serve logs
  `config.deprecated reconciler.intervalMs ignored; use github.backstopIntervalMs` at start.
  Remove it from the file.
- `fullEvery` (default 3) caps how many ticks a quiet repo can go without a full GraphQL
  snapshot. A repo is quiet when its conditional gates all answer 304 and its last snapshot
  had no check or status still running.
- `repos` lists the `owner/name` repos to watch.

Every GitHub read is a claim on the bot's `github-api` pool at backstop priority, the lowest.
While the pool holds any call class closed, the reconciler skips the repo on that tick, and a
claim the pool answers as unavailable is skipped the same way. A skipped repo writes no row and
moves no cursor. The next granted tick reads the whole range from the cursor, so nothing is
lost. When a repo is skipped on more than 2 ticks in a row, serve logs `reconciler.starved`
once, with the time the first skip happened.

On serve start, the first tick is a forced full pass over every repo. Serve does not wait for
it. A repo the pool skips during that pass is forced again on the next tick. With no cursor,
main and closed PRs are read back 24 hours.

The cursor lives in the factory database (migration 36, `factory_reconciler_cursor`), with one
row per repo and stream (`main`, `done`, `rulesets`). Appends come before the cursor write. A
crash between the two re-reads the same range on the next tick, and every row it sees again
comes back as a duplicate.

Each tick writes one serve-log line per outcome:

| Line | Meaning |
|---|---|
| `reconciler.filled` | a row no webhook had written was appended |
| `reconciler.confirmed` | a webhook row already held the occurrence; nothing was written |
| `reconciler.disagree class=stale-read` | the read was behind the log; nothing was written |
| `reconciler.disagree class=field-parity` | the same occurrence came with a field that differs |
| `reconciler.disagree class=main-ancestry-lost` | main lost ancestry between cursor and tip; the cursor resets to the tip |
| `reconciler.disagree class=unconfirmed` | the head guard was pending or unknown; the next tick reads again |
| `reconciler.skipped` / `reconciler.starved` | the pool refused the repo's claim |
| `reconciler.unit-failed` | the read or a step threw; the repo's cursor stays where it was |

## A17 invariant tests: both event-source modes

A17 says an invariant holds whether GitHub observations arrive as webhook deliveries or are polled. The harness in
`products/factory/src/test-support/a17/` runs one case under both modes.

**Every later A17 event case must use `a17Event`.** An event case is one whose arrange step feeds GitHub observations: it
reaches `appendEvent`, the ingress handler or the reconciler's observe and schedule. A task that adds one inherits the
done_when line "the case passes under `sources=webhook` and `sources=polling`".

```ts
a17Event("a green status is recorded once", (feed) => {
  feed.fact(status({ outcome: "success" }));
  expect(feed.read("o/r", 0)).toHaveLength(1);
});
```

`a17Event(title, body)` registers `A17: <title> [webhook]` and `A17: <title> [polling]`. The body gets a `Feed` and
nothing that names the mode, so a case cannot skip one by branching.

- `feed.fact(fact)` is a state that holds across a reconciler tick. Under webhook it is delivered, then re-observed by the
  backstop; under polling it is observed at the tick.
- `feed.transient(fact)` is a state that holds between two ticks only. Under webhook it is delivered, so a row exists;
  under polling it is never observed. A case that depends on a transient declares it this way, in one place.
- `feed.pick({ webhook, polling })` is the one way a case states an expectation that differs by mode; both answers are
  required.
- `feed.advance(ms?)` moves the fake clock, by one reconciler interval of the mode when `ms` is omitted.
- `feed.limit(answer, reads?)` makes GitHub answer the bot's next reads with a limit or failure. The reads go through the
  bot's `github-api` pool, whose state is the factory's own pool-state table and whose clock is the feed's, so a closed
  pair reopens when `advance` passes its `resetAt`. `feed.reads()` counts the reads GitHub answered.
- `feed.head(repo, pr)` is the head GitHub shows for an open PR, for a case that drives the head guard's live reads.

`test-support/a17/structure.test.ts` runs inside `pnpm test` and fails when, anywhere under `products/factory/src`:

1. a test title containing `A17:` is written with `it`, `test` or `describe` in a file that imports `event-log/`,
   `github-sources/`, the ingress or the reconciler, instead of going through `a17Event`; or
2. an A17 title carries `.skip`, `.todo`, `.only`, `.skipIf` or `.runIf`.

A case with no GitHub input, such as the M0 deploy probe cases, stays single-mode and is listed in `NOT_EVENT`
(`test-support/a17/not-event.ts`) with the file, the title as written and a reason. The guard also fails on an entry whose
file no longer carries its title. CI reruns the whole factory package when anything in it changes, so the guard runs on
every factory change.

## Webhook ingress {#webhook-ingress}

`serve` owns a second loopback listener that takes GitHub webhook deliveries. It is a separate listener so the daemon's Host and
Origin guards on 7410 stay as they are, and a Funnel typo cannot expose `/rpc` or `/mcp`.

| What | Value |
| --- | --- |
| Path | `/ingress/github` (POST only) |
| Local listener | `127.0.0.1:7411` |
| Public route | `https://<host>.<tailnet>.ts.net/ingress/github`, forwarded to `http://127.0.0.1:7411/ingress/github` |
| Secret file | `$XDG_CONFIG_HOME/titan-factory/secrets/github-webhook.token`; on the serve host `~/.config/titan-factory/secrets/github-webhook.token` (directory 0700, file 0600) |
| Kill switch | `github.ingress` (`"on"` or `"off"`, default `"off"`) in `~/.config/titan-factory/config.json` |

`<host>.<tailnet>.ts.net` stands for the serve host's Funnel name, shown by `tailscale status --json | jq -r .Self.DNSName`.

The route is live only when `github.sources` is `"webhook"` **and** `github.ingress` is `"on"`. Otherwise every request gets
`404 {"error":"ingress off"}` before the body or the secret is read. The listener binds even when the switch is off, so a flip
takes effect on the next request with no restart.

**The switch stays off until the polling-only 48 h has passed.** Register the webhooks and flip the switch only after that. The
two clocks, what resets them and the commands for each are in [F11 gate](#f11-gate).

**Parse-only (R28).** The ingress verifies the signature, stores a capped projection of the delivery as one `source='webhook'`
event, and acts on nothing. No recipe or service reads what it writes at M1a.

### Owner steps

D1 and D2 (the tailnet ACL `funnel` nodeAttr, scoped to the serve host and never `"*"`) are separate and can run now. D6 needs no code
and can run now. D3 to D5 wait until the ingress listener is deployed on the serve host: before that, 7411 has no listener and Funnel
answers 502.

**D3. Check that serve's ingress listener is up** (on the serve host):

```sh
ss -ltn 'sport = :7411'
curl -sS -X POST http://127.0.0.1:7411/ingress/github
```

The first line must list `127.0.0.1:7411`. The curl must print `{"error":"ingress off"}`.

**D4. Add the one Funnel route** (on the serve host):

```sh
sudo tailscale funnel --bg --set-path /ingress/github http://127.0.0.1:7411/ingress/github
```

Never run `tailscale funnel 7410`, and never run `tailscale funnel` without `--set-path`.

**D5. Check that only that route is public:**

```sh
tailscale funnel status
curl -sS -X POST https://<host>.<tailnet>.ts.net/ingress/github
curl -sS -o /dev/null -w '%{http_code}\n' https://<host>.<tailnet>.ts.net/health
```

- `funnel status` must list exactly one entry: `https://<host>.<tailnet>.ts.net/ingress/github`, proxying to
  `http://127.0.0.1:7411/ingress/github`.
- The first curl must print `{"error":"ingress off"}`.
- The second curl must print `404`. That 404 comes from Tailscale and shows serve's `/health` is not public.
- If the first curl prints `{"error":"not found"}` instead, Tailscale appended the mount path twice. Run
  `sudo tailscale funnel --set-path /ingress/github off`, then re-run D4 with the target `http://127.0.0.1:7411`, then re-run D5.

**D6. Make the webhook secret straight into its file** (on the serve host, as the serve user):

```sh
umask 077
mkdir -p ~/.config/titan-factory/secrets
chmod 700 ~/.config/titan-factory/secrets
openssl rand -hex 32 > ~/.config/titan-factory/secrets/github-webhook.token
chmod 600 ~/.config/titan-factory/secrets/github-webhook.token
ls -l ~/.config/titan-factory/secrets/github-webhook.token
```

The last line must start with `-rw-------`. The secret is never printed, pasted or sent in chat. Serve picks it up on the next
delivery, with no restart.

### F11 gate {#f11-gate}

F11 (TP-3103) is the order webhooks go live in: 48 hours on polling alone, then the ingress, then 48 hours of webhook plus
backstop. Each clock passes on its own report, and the M1a exit cites both.

**Before clock 1 starts**, all of these hold:

1. The deployed sha carries the reconciler wired to serve as the bot (TP-3431), the meter below, and the bot token path
   (TP-3419). Write the sha down.
2. The bot token is on disk, mode 0600. `curl -s http://127.0.0.1:7410/health | jq .bot` shows `state: "ok"`, and
   `titan-factory bot-token scan` prints `bot-token scan: clean`.
3. `~/.config/titan-factory/config.json` sets polling with the switch off and the reconciler on, over the four repos:

   ```json
   {
     "github": { "sources": "polling", "ingress": "off" },
     "reconciler": { "enabled": true, "repos": ["HJewkes/titan-platform", "HJewkes/titan-design", "HJewkes/agent-chat", "HJewkes/voltras-mcp"] }
   }
   ```

   `curl -s http://127.0.0.1:7410/health | jq .sources` shows `effective: "polling"`, `reason: "configured"` and a
   `lastPassAt` that advances, and `sources.reconciler: "running"`. Any other value stops the gate; see
   [Reconciler health and cost](#reconciler-health-cost).
4. The first pass read each repo's rulesets with status 200, not the 403 `unreadable`. A repo that answers 403 stops the
   gate: its ruleset changes can never pass the census.
5. Both meters run, and the old pollers keep running: nothing in Shepherd retires at M1a.

**The meters.** The bot side is inside serve, so its token never leaves it. Serve logs a `github-api.usage` line every 5
minutes and a `github-api.peak` line every hour, each with `identity`, `resource` (`core`, `graphql`), `used`, `limit`,
`pct` and `reset`. A peak line carries the highest `used` per reset window, not the last read. They go to
`serve.err.log` with the rest of serve's lines:

```sh
grep 'github-api.peak' "$XDG_STATE_HOME/titan-factory/serve.err.log"
```

The HJewkes side is a sampler run as HJewkes from the service checkout. It calls `gh api rate_limit` once a minute, which
costs no rate-limit points, and appends one JSONL record per sample. `--peaks` prints the highest `used` per resource and
reset window:

```sh
node products/factory/scripts/f11-rate-sample.mjs --out <jsonl>
node products/factory/scripts/f11-rate-sample.mjs --peaks <jsonl>
```

**Clock 1: polling only, 48 h.**

- It starts when the five conditions above hold.
- Make one planned restart near the 24 h mark with `titan-factory service restart`, so the peaks cover a restart and its
  forced start pass.
- The reconciler's own record (TP-3098) comes from the first 24 h.
- It passes when the census shows no `missing` kind against the kinds that occurred in the window, no unexplained
  `reconciler.disagree class=field-parity` line, and a bot peak under 50% of the limit in both buckets.

**Boundary.** Run [Go-live](#go-live) G1 to G3. Re-check D5 first: `tailscale funnel status` lists exactly one route.

**Clock 2: webhook plus backstop, 48 h.** The backstop runs at `github.backstopIntervalMs` (default 5 minutes). Write down
each of three deliberate probes:

- Redeliver one real `pull_request` delivery from the GitHub UI. It must append no new row (a duplicate `by: delivery`).
- Re-run one check on a scratch PR, and record whether the re-run gets a new `checkRunId`.
- Set `github.ingress` to `"off"` for one backstop interval, then back to `"on"`. The backstop catches up what the switch
  dropped.

Stale reads are counted from `reconciler.disagree class=stale-read` and `head-regression` lines. Clock 2 passes when no
row is webhook-only past the pending window, each backstop-only row is explained, no key diverges (dedupe holds), and no
`head-regression` line shows an epoch going backward. The A17 report on the deployed sha must list every case as ok in
both modes:

```sh
pnpm --filter @titan-design/factory a17 --out <file>
```

**What resets a clock.**

- A deploy that changes `reconciler/`, `github-sources/`, `event-log/`, `ingress/`, `head-guard/` or `bot-identity.ts`
  under `products/factory/src/`. Note any other deploy, but it does not reset the clock.
- A `reconciler.unit-failed` streak of more than 3 ticks on one repo.
- A `missing` kind that did occur in the window.

**The report.** `products/factory/scripts/f11.mjs` lands with F6. It reads the database and the serve log over a window
and writes the census (clock 1) or the agreement (clock 2), the stale-read counts and both identities' peaks:

```sh
node products/factory/scripts/f11.mjs --db <db> --log <serve.err.log> --since <iso> --until <iso> \
  --clock polling|webhook --rate <jsonl> --out <file>
```

Its `log` line counts the `reconciler.cost` lines in the window; their fields are in
[Reconciler health and cost](#reconciler-health-cost).

### Reconciler health and cost {#reconciler-health-cost}

Serve runs the reconciler as the bot or not at all (TP-3431, I13). It never falls back to the user's client.
`GET /health` reports which with `sources.reconciler`:

| Value | Meaning |
| --- | --- |
| `running` | `reconciler.enabled` is on and the bot can run it; the sweep started |
| `disabled` | `reconciler.enabled` is off, or the config has no `reconciler` block |
| `no-bot` | `reconciler.enabled` is on, but the bot cannot run it, so serve started nothing |

`no-bot` comes with one `reconciler.no-bot` warning at start, whose `reason` says why:

| `reason` | Cause |
| --- | --- |
| `absent` | no bot token file |
| `refused` | the token file failed its checks (for example a mode other than 0600); `.bot.problem` in health names which |
| `no-login` | the token is fine but `BOT_LOGIN` in `bot-identity.ts` is undefined, so C7 cannot tell the bot's writes apart |

Serve decides once, at start. Fix the cause, then `titan-factory service restart`.

While it runs, the reconciler logs one `reconciler.cost` line per repo per pass. A skipped pass (the pool refused the
claim) and a failed one (`reconciler.unit-failed`) log it too, so a pass that spent nothing still says so:

| Field | Meaning |
| --- | --- |
| `repo` | `owner/name` |
| `graphqlCost` | GraphQL points the snapshot spent, from its `rateLimit.cost`; 0 on a quiet tick with no snapshot |
| `restCalls` | REST reads: the conditional gates plus each head guard compare |
| `notModified` | how many of the gate reads answered 304 |
| `appended` | rows this pass wrote, counted by event kind; a confirmed duplicate is not counted |

```sh
grep 'reconciler.cost' "$XDG_STATE_HOME/titan-factory/serve.err.log"
```

### Go-live

After [clock 1](#f11-gate) has passed:

**G1. Register the webhook on each of the four repos** (titan-platform, titan-design, agent-chat, voltras-mcp). This needs repo
admin, so it runs as HJewkes. The secret goes from the file through stdin, never through argv:

```sh
for repo in titan-platform titan-design agent-chat voltras-mcp; do
  jq -n --rawfile s ~/.config/titan-factory/secrets/github-webhook.token '{name:"web",active:true,
    events:["check_run","status","pull_request","pull_request_review","push","repository_ruleset"],
    config:{url:"https://<host>.<tailnet>.ts.net/ingress/github",content_type:"json",insecure_ssl:"0",secret:($s|rtrimstr("\n"))}}' \
  | gh api -X POST "repos/HJewkes/$repo/hooks" --input - --jq '.id'
done
```

Each repo's ping delivery reaches a switch that is still off, so it gets 404. That is expected.

**G2. Flip the kill switch.** In `~/.config/titan-factory/config.json`, set `"github": {"sources": "webhook", "ingress": "on"}`.
No restart is needed. Check with `curl -s http://127.0.0.1:7410/health | jq '.sources, .ingress'`: it must show
`effective: "webhook"` and `listening: true`.

**G3. Redeliver one ping per repo** from Settings, Webhooks, Recent Deliveries, Redeliver. Each must show 200, and
`health.ingress.lastDelivery.event` must be `ping`.

### Rollback

- **Operational, with no deploy:** set `"ingress": "off"` (or remove the `github` block). The next delivery gets 404 and polling
  takes over. To close the public route: `sudo tailscale funnel --set-path /ingress/github off`.
- **Code:** each slice is one revertable commit. Reverting the listener removes it; the projections and the core are then dead
  code, so revert them too. There is no migration and no stored state outside the event log, and rows already written stay valid.
- **Secret leak:** rotate with D6 (overwrite the file), then `gh api -X PATCH repos/HJewkes/<repo>/hooks/<id>/config` with the
  same jq-from-file form. Serve re-reads the file on change.

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
| `GET /health` | run counts by status, pending gate count, the busy runs, the GitHub probe, `build` (sha and whether it is behind main), `lastDeploy`, `deploy` (the deploy alarm, when serve runs it), `deployPaused` (the rollback pause) and `deployHeld` (the manual or Morning hold; see [below](#service-deploy-redeploy-from-main)), `ownerKeys` (the loaded owner key ids, or why none loaded), `startedAt`, `uptimeSeconds`, the start counts `restartCount`, `uncleanStartsTotal` (starts that found a stale pid file) and `restartsToday` (UTC), kept in `serve-starts.json` in the state directory, version, pid, port |
| `POST /rpc/<command>` | one registry command; the body is its JSON arguments |
| `POST /gates/resolve-proof` | applies an owner-signed proof and returns each item's outcome; see [Owner-signed proofs](#owner-signed-proofs) |
| `POST /holds/release-proof` | lifts one Shepherd hold on an owner-signed release; see [Owner-signed hold release](#owner-signed-hold-release) |
| `POST /gates/answer-ship` | only with `shepherd.consoleAnswers` set: resolves an approve-merge gate as `owner-remote` from a console Ship answer; see the factory README |
| `/mcp` | the same commands as MCP tools over streamable HTTP |

```sh
curl -s http://127.0.0.1:7410/health
```

```json
{"runs":{"running":2,"paused":0,"cancelling":0,"recovery_required":0,"completed":0,"failed":0,"cancelled":0},
 "pendingGates":0,"busy":[],"github":"ok","build":{"sha":"0123456789abcdef0123456789abcdef01234567","behindMain":0},
 "lastDeploy":null,"ok":true,"version":"0.1.0","pid":4242,"uptime_ms":4784,"port":7410}
```

`github` is `ok` when `gh api rate_limit` succeeds in the server's environment, the redacted
`gh` error when it fails, and `checking` before the first probe lands. The probe runs in the
background at most once a minute, so a health request never waits on `gh`.

The registry commands are `factory.land`, `factory.status`, `factory.gates`, `needs.list`,
`needs.count`, and the 14 `shepherd.*` commands. A `/rpc` call needs an `Origin` header or an `X-Titan-Client` header;
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

Abandoning an `approve-merge` gate after the reviewer said MERGE at that head, or a seat
reviewer and Shepherd's own review giving opposite verdicts at one head, records an
`ownerOverride` on the run. `titan-factory shepherd stats` (and `--json`) reports the weekly
rate per repo: overrides divided by runs with a MERGE verdict.

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

### Owner-signed hold release {#owner-signed-hold-release}

`POST /holds/release-proof` lifts one Shepherd hold on a `titan-factory.hold-release` statement,
with `applyHoldRelease` behind it. It takes the same body, keys, guards and size limit as the gate
route. The statement carries the same envelope (`v`, `aud`, `keyId`, `nonce`, `iat`, `exp`) and
exactly one item: `{runId, repo, pr, holdDigest, holdSince, headSha}`. `holdDigest` is the sha256
hex of the hold reason the owner read. `holdSince` is the `at` of the run's latest hold or release
event in `shepherd timeline`, so a re-hold with the same text is a different hold and an unspent
proof for the earlier one cannot lift it. Its `type` keeps it from ever being read as a gate
resolve, and the reverse.

1. The signature, window and audience are checked as for a gate proof, and a used nonce is refused.
2. `repo#pr` must be registered to `runId` (else `run-mismatch`), held (else `not-held`), and held
   under exactly the signed reason since `holdSince` (else `hold-changed`). None of these refusals
   writes anything.
3. The proof is recorded, which spends the nonce, with one item `hold:<runId>`.
4. The PR head is read from GitHub. A head other than `headSha` is `head-moved`, and the item is
   recorded `skipped-moved`. An unreadable PR is `head-unreadable` (503). Both spend the proof:
   the owner signs a new one to retry.
5. The hold is released only while it is still the signed reason, with actor `key:<keyId>` and the
   head on the release event. A hold that changed during the read is `hold-changed`.

A success answers `{ok, batchId, runId, actor}`. Refusals answer 409 for a replay or a stale hold or
head, 403 for a bad proof, and 503 without owner keys or without the Shepherd routes. This route adds
a way to release; it does not yet stop `shepherd release` lifting any class.

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
have had its effect is parked as `recovery_required` for a human. The post-merge chore is
reconciled from its result file instead: a finished chore is recorded, a running one is
awaited, and only a chore that is gone and wrote no result parks the run.

## `review` {#review}

```sh
titan-factory review acme/widgets#7                # review the PR's current head
titan-factory review acme/widgets#7 --head <sha>   # review this full head sha
titan-factory review acme/widgets#7 --json         # one JSON object: outcome, head, fingerprint, members
titan-factory review acme/widgets#7 --wait-ci      # wait out pending CI, and follow a moved head once
titan-factory review resolve <fingerprint>         # review every run parked on the fingerprint again
```

`review` runs the review workflow (`@titan-design/review-workflow`) on one PR head with no
Shepherd run: preflight, the panel's members, and the aggregate. It reads the reviewer
profiles, `agentChatBin`, the timeouts and the disk floors from `shepherd.review`, and the
repo's checkout from the seat book or `shepherd.repos`. It prints the outcome, the head, the
run id and each member dispatch. It posts nothing to GitHub and never updates the branch.

| Outcome | Exit | What to do |
|---|---|---|
| `MERGE`, `carried` | 0 | nothing |
| `needs-update` | 1 | the branch is behind and merges clean; the author updates it, then reviews again |
| `needs-fixer` | 1 | a hard error parked the run and spawned a read-only `bd-planner` fixer that proposes a fix; once the fix is in, run `review resolve <fingerprint>` |
| any other | 1 | read the outcome line |

`review resolve` reviews every run parked on the fingerprint again, each as a fresh run, and
exits 0 only when every one ends in `MERGE` or `carried`. Runs and parked fingerprints live in
`review.sqlite3` beside the factory database, so `serve` never picks them up.

`--wait-ci` polls every 30 seconds for up to an hour. Each pass stops at preflight, so waiting
spends no reviewer session. CI comes from the base's required checks. When none can be read,
it comes from every check run at the head: green once all have completed and none failed.
The `CI:` line (and `ci` under `--json`) names which source was used.

With no Shepherd run, the PR itself opens the fix-proof gate. A `fix/` head branch opens it,
and so does a `fix-proof` run from GitHub Actions at the head. The review then reads that
check's result line once, without waiting, so a `NO_REPRO` line ends the review as
`NO_REPRO`. A `fix-proof` run still going reads as unverified. The review carries nothing
across merge-ups.

## `shepherd brief` {#shepherd-brief}

```sh
titan-factory shepherd brief owner/repo#N [--format md|round-section] [--images <dir>]
```

Prints the owner section for a PR that waits on its `approve-merge` gate: what it does, why it reaches the owner, pros and cons from the reviewer's owner brief, a recommendation, and what yes and no do. It reads the PR through the GitHub port (view, files, checks at the head), the run, pending gate, latest verdict and owner brief from Shepherd's store, and the task title and done_when from active-work. It writes nothing to GitHub or Shepherd.

- `--format md` (the default) prints the markdown section. `--format round-section` prints `{ section, question }`, a round@2 section and its pick-one question for the review harness.
- `--images <dir>` reads `<dir>/pr-<n>/manifest.json` for a UI PR and adds before and after variants. A missing manifest, `rendered: false`, a shot missing its before or its after, or a manifest captured at another head gives a stated reason and no images; an after-only set is never shown.
- A PR that is not registered, or has no pending `approve-merge` gate, exits 66 with the reason. An unreadable task is stated in the section instead of failing it.

## `digest run`

```sh
titan-factory digest run --dry-run   # print the owner digest for the current slot
titan-factory digest run             # write <date>-<HH>.md to the digest dir and the iCloud dir
```

The digest covers every seat in the seat book in under 400 words: Needs you, Decided for you
(the decider's answers, each with its overrule command), Merged, Stuck, Seats and Spend. A source that cannot be read becomes a Gaps line instead of a failure. The
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
| `service check [--port <n>] [--json]` | Read-only diagnosis: one line naming the first cause that holds (`unreadable`, `not loaded`, `stale pid`, `crash loop`, `unresponsive`, `stale build`, `GitHub down`, `stale index.lock`, `deploy stalled`, `no hub seat`, `stale CLI`); a deploy the pacer holds adds `; deploy <sha> waits: <why> until <time>` to the line and `deployWaitSha`, `deployWaitWhy` and `deployWaitUntil` to `detail`; `--json` adds `cause`, `pid`, `health` and `detail` | `/health` answers from the launchd or systemd pid with `github` `ok`, deploys are not stalled, and a hub seat is configured; a `stale CLI` alone still exits 0 |
| `service restart [--port <n>] [--drain-timeout <d>] [--no-drain] [--force]` | Waits until the runs `/health` listed busy at the start clear, fences a foreign serve on the port, restarts without blocking on the stop and fences a process that outlives it by 45 s, then the same wait as install | the new process answers with `github` `ok` |
| `service deploy [--expect <sha>]` | Fast-forwards the service checkout, rebuilds the factory when the range touches it, restarts drained; see [below](#service-deploy-redeploy-from-main) | the target is deployed, already deployed, or skipped as untouched |
| `service uninstall` | Boots the job out when loaded, then removes the plist | the job is unloaded |

On Linux the same verbs manage the systemd --user unit `titan-factory.service` in
`$XDG_CONFIG_HOME/systemd/user/`, else `~/.config/systemd/user/`. The unit runs the plist's
argv with `Restart=always`, the plist's `PATH` and its two log files, and is enabled under
`default.target`. Install runs `daemon-reload` and `enable --now` (plus `restart` when the unit
was already running), then the same `/health` wait. `service install --dry-run` prints the file
and the calls it would make, and changes nothing. Run `loginctl enable-linger "$USER"` once so
the unit runs without a login session. The package README maps each plist key to its unit line.
The unit sets `TimeoutStopSec=60`; `service deploy` never rewrites the unit, so run
`titan-factory service install` once after the release that adds it.

`service restart`, `service deploy` and a deploy's rollback never wait behind a serve that ignores
SIGTERM, which a serve with a blocked event loop does. They queue the restart without blocking
(`systemctl --user restart --no-block`, or `launchctl kickstart -k`), wait 45 s
(`STOP_FENCE_MS`) for a new main pid, then SIGKILL the old one through the service manager
(`systemctl --user kill --signal=SIGKILL`, or `launchctl kill SIGKILL`) and print
`fenced pid N (... MainPID, alive 45 s after SIGTERM)`. The `/health` wait starts only after the
new pid exists. Before that, a listener on the port outside the unit or job is fenced only when its
command line proves it is `titan-factory serve` (SIGTERM, 15 s, a start-time re-check, then
SIGKILL, printed as `fenced pid N (titan-factory serve outside ...)`); any other holder is refused
by pid and argv with no signal sent. The package README has the full sequence.

`service check` defines each cause precisely and reports the first that holds, in this order:

The whole check prints within `SERVICE_CHECK_BUDGET_MS` (20 s): up to three `/health` probes of at most 6 s each,
1.5 s apart, each cut to what is left of the budget.

On Linux it reads `systemctl --user show titan-factory.service` instead: `MainPID` is the pid
(none unless `ActiveState` is `active`), `NRestarts` stands in for the run count and
`ExecMainStatus` for the last exit code.

- **unreadable**: on Linux, `systemctl --user show` itself failed (no user bus, permission, timeout); the line carries its stderr, or `exit N` when it printed none, and `--json` puts both in `detail.exitCode` and `detail.stderr`.
- **not loaded**: `launchctl print` finds no `dev.hjewkes.titan-factory` job, or the unit's `LoadState` is not `loaded` on a successful read.
- **stale pid**: launchd's pid is dead, a different pid answers `/health` on the port, or launchd holds no process or one that gives no usable `/health` answer, such as a refused connection (and it is not crash-looping).
- **crash loop**: launchd's last exit code is non-zero, the job has started at least 3 times, and it holds no process or its process started under 5 minutes ago and does not answer `/health` itself. `service restart` and `launchctl kickstart -k` leave a non-zero last exit and bump the run count, so a young process whose `/health` body names the launchd pid is a restart, not a crash loop.
- **unresponsive**: launchd's or systemd's pid is alive but every `/health` probe timed out, as a hung or deadlocked serve does. `--json` lists each probe's latency in `detail.probeLatenciesMs`. Like `stale pid`, it means serve cannot take work.
- **stale build**: a restart would load a newer commit than the build in `/health`. The check compares the running sha with the build baked into the dist of the deploy checkout the unit runs and reports only when the running sha is an ancestor of that build, so it never advises a restart that loads an older or diverged commit; an `unknown` running sha never counts.
- **GitHub down**: the right pid answers but `github` is not `ok`.
- **stale index.lock**: the service checkout's `.git/index.lock` has no process holding it and is older than 10 minutes. The line names its path and age. `service check` never removes it; a person does, once no git runs there.
- **deploy stalled**: the deploy block in `/health` has its alarm up (see [below](#service-deploy-redeploy-from-main)). The line names each cause, with the last refusal's reason; `--json` adds the running sha, the waiting asks, the refusals in a row and the last refusal.
- **no hub seat**: the config sets no `shepherd.hubSeat`, so a deploy alarm reaches no seat. It is reported only once the server and the burndown tick are sound.
- **stale CLI**: the `titan-factory` on PATH, resolved through symlinks, was built from a commit behind the deploy checkout's HEAD, so verbs added since fail as unknown options. Point it at the deploy checkout's `dist/bin.js` or rebuild it; `service restart` does not change the CLI. It is advisory: reported last, with `ok` still true and exit 0, so the burndown tick and the watchdog do not stop on it. The deploy bin itself is never reported, because a rolled-back deploy leaves it behind HEAD on purpose.

It never starts, stops or restarts the job.

`service check` exits with:

| Code | Meaning |
| --- | --- |
| `0` | `/health` answers from the launchd or systemd pid with `github` `ok`, the build is not stale, and deploys are not stalled |
| `1` | One of the causes above holds, or the platform is neither macOS nor Linux |
| `2` | Usage error, such as an invalid `--port` |

A server installed with `--port` needs the same `--port` on `status` and `restart`. On any
other platform these six verbs fail with one line.

`service restart` drains first. It polls `/health` every 5 s until no run that was busy at its
first answer is still busy, and prints the busy runs once a minute. Serve keeps admitting review
and merge steps during the drain, so a run that turns busy later does not hold the restart, and
the drain names it instead; a park-routed step holds the restart whenever it is busy. A run is busy when it is `running` and its
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

`service deploy [--expect <sha>]` rebuilds and restarts the service from the dedicated deploy
checkout, which must be on `main` with no tracked changes. No agent or coordinator uses it as
a cwd, so a reviewer's in-place checkout can no longer block a deploy. Its path is
`service.deployCheckout` from the factory config, else `deploy/titan-platform` under the app
data dir (`@titan-design/app-paths`, app `titan-factory`). When it is absent, deploy runs
`git clone --branch main <remote>` into it, never a copy of a working tree; the remote is
`service.deployRemote`, else the origin of the checkout the CLI runs from. While the installed
unit or plist does not start the deploy checkout's bin, every run only fast-forwards and
builds it, never restarts, and says to run `service install`; the automatic redeploy after a
merge therefore cannot restart the service onto the old tree and roll back. It takes the pid lock
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
failure; only a wrong sha, or no sha in the whole poll, fails. Once the sha checks out, the
deployer watches the new build for `--watch-window` (default `service.deployWatchMs`, else
2 minutes), probing `/health` every 10 s with a 5 s timeout. When that probe times out and
the restarted pid is still alive, the tick retries once with a 30 s timeout. An answer on the
retry counts as slow, not as a miss; a dead pid gets no retry. The watch fails when three ticks
in a row get no answer, when every probe in the window was slow, when the build sha or the pid
changes, or when the `failed` plus `recovery_required` run counts rise above the answer that
confirmed the sha. The watch has no start-up grace, and needs none. The sha poll already waits
for the first answer, and a live pid that answers nothing needs about 3 × 45 s, so 135 s, to
fail. That is longer than the 120 s window and well past the 17–32 s Shepherd resync measured
after a restart (TP-2433). A grace would only hide a serve that hangs from its first second.
A failed install or build restores
the snapshot and leaves the old process running, untouched; it records `rolled-back`, and that
sha is then held until a newer one arrives.
A failed install or build also writes `deploy-build.log` beside `deploy.json`: the command,
target, time, exit code and the redacted last 200 lines of stderr and stdout. The record's `why`
keeps a 20-line tail and names the log; the file holds only the newest failure.

A failed restart, sha check or watch pauses every deploy. The deployer writes
`deploy-pause.json` beside `deploy.json` before it restores anything, so a deployer killed
mid-rollback still leaves the pause. It then restores the snapshot, kickstarts once, and
checks that `/health` answers as the build that ran before. The pause records the rollback as
`verified`, or as `failed` when the old sha does not answer or was unknown. Either way the
deployer sends one incident notice, to the hub seat when `shepherd.hubSeat` is set and always as
an owner-queue item. A failed rollback also prints an `ALERT:` line, and nothing retries it.
While the file exists, every `service deploy` is refused with `deploy held: deploys are
paused`, whatever its sha, and a pause file that does not parse still pauses. `titan-factory
service pause` shows the pause. `titan-factory service pause --clear` removes it under the
deploy lock, so it is refused while a deployer runs.

The incident item and the stall alarm's item both go to the console's inbox spool as asker
`titan-factory`, keyed `deploy-incident` or `deploy-alarm` plus an `alarm:<kind>:titan-factory`
key that folds repeats into one inbox item. Once a later deploy records `deployed`, the deployer
withdraws every open one of them with reason `resolved` and actor `titan-factory` (owner-queue's
`withdrawMatching`), and logs how many. A failed withdraw is printed and does not fail the deploy; a `skipped`, `held` or
rolled-back deploy withdraws nothing.

`/health` carries the same pause as `deployPaused: {paused, since, reason, lastRollback}`, where
`lastRollback` is `{target, from, status}` and `status` is the rollback's `pending`, `verified` or
`failed`. With no pause file it reads `{paused: false}` and nulls. A pause file that does not
parse reads `paused: true` with that as the reason, because the deployer holds on the file's
existence. A file that cannot be read at all reads `paused: null` with the read error as the
reason; `/health` still answers. The key covers only `deploy-pause.json`; the manual hold
below is `deployHeld`.

A person can hold deploys by hand with `titan-factory service pause --set <reason>`. It writes
`deploy-hold.json` beside the pause file, a separate file so a rollback cannot overwrite the
reason and the reason cannot overwrite a rollback's. The hold is honoured exactly like the
pause: under the deploy lock every `service deploy` is refused, and the deploy pacer spawns no
deployer. `--set` does not take the lock, so it can be set while a deploy runs; it then says the
hold applies from the next deploy. A second `--set` replaces the reason. When both a pause and a
manual hold stand, `service pause` and the `deploy held:` refusal show both reasons.
`--clear` lifts both and prints one line for each hold it lifted.

`/health` carries the manual hold as `deployHeld: {held, since, reason, source}`, read through
the same reader the deployer uses. `source` is the Morning item that set the hold, or null for a
`--set`. Its null rules match `deployPaused`: no file reads `{held: false}` and nulls, a file that
does not parse reads `held: true`, and one that cannot be read reads `held: null` with the error
as the reason. Deploys are held unless both `deployPaused.paused` and `deployHeld.held` are
`false`.

A seat's Morning queue can hold deploys too. A numbered item under `## Morning queue (owner
only)` in a `<seat>.md` queue file whose text starts with `DEPLOY HOLD:` (case-sensitive, bold
allowed) sets the manual hold with the item's reason and `source: morning:<seat>:<n>`, for example
`7. DEPLOY HOLD: copy the db before the migration deploys. One-way.` An item that only mentions a
deploy hold mid-text does nothing. The deploy pacer syncs the hold at each tick before it decides,
so the tick that sets it spawns nothing, and `service deploy` syncs it under the deploy lock
before it reads the holds. Removing the item clears the hold once two pacer ticks in a row find no
hold item, so a queue file caught mid-rewrite cannot clear it. That count lives in serve's memory:
a restart starts it at 0, which can delay a clear by a tick and never causes one. A one-shot
`service deploy` can set a Morning hold but never clears one. The sync never overwrites or clears
a hold set by hand, keeps every hold when a queue file cannot be read (a missing dir counts), and
never reads, writes or removes `deploy-pause.json`. A `--clear` while the item stands is undone by
the next tick, so remove the item instead. The queue files are the Morning digest's
(`digest.queuesDir`, else the default under the active-work root).

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
gets an agent-chat message when the alarm goes up, and again every
`shepherd.deployAlarm.renotifyTicks` checks (default 6, so 30 minutes) while it stays up. A
failed message is retried on the next check. Once the alarm has stood for
`shepherd.deployAlarm.escalateAfterMinutes` (default 30), serve files one `do` item for the owner
into the titan console's deposit spool (`$TITAN_CONSOLE_INBOX_DIR`, else
`$TITAN_CONSOLE_STATE/inbox/deposits`, default `~/.local/state/titan-console/inbox/deposits`),
keyed on the running build so a restart files no second one. That item is filed with or without
a hub seat. With no `shepherd.hubSeat`, serve logs a warning at start and `service check` fails
with `no hub seat`.

It takes the same `--port`, `--drain-timeout`, `--no-drain` and `--force` as `service restart`.
It exits 1 on a refusal, a held sha, a pause, a lock held by a live deployer, or a rollback. The
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

The plist names the deploy checkout's built bin and sets `WorkingDirectory` to that checkout.
After you move the checkout or change node, run `service install` again, or print and
bootstrap the plist again.

#### Migrating to the dedicated deploy checkout

One-time, from any checkout that has this change built (the old dev tree is fine):

1. `titan-factory service deploy` clones and builds the deploy checkout. It does not restart
   the service.
2. `titan-factory service install` re-renders the plist or unit so serve runs from the deploy
   checkout, and restarts it. Install refuses until step 1 has built the bin there.

The old `~/projects/titan-platform` checkout is then no longer a deploy target and keeps working
as a dev tree. Later `service deploy` runs fast-forward only the deploy checkout, from any
checkout's bin.

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
| a run `failed` with `ci-wait timed out after 2700000 ms on each of 3 attempts` | GitHub never settled the PR in 3 windows in a row: mergeable_state stayed unknown, an open repo's run set kept changing, or reads kept failing with a 5xx |
| a run `failed` with `requires no status checks` | the base branch has no required check |
| `/health` shows `"github":"gh api rate_limit failed …"` | the server's environment cannot use `gh` |

Exit codes are 0 for success, 1 for a failure, and 2 for a usage error. A failed step stores
its error with `gh` token shapes and `Authorization:` values replaced and the text capped at
500 characters (`products/factory/src/redact.ts`).

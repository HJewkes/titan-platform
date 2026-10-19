# titan

**Product.** Private, never published. Depends on [`health`](/reference/health) and
[`daemon`](/reference/daemon).

```sh
pnpm build
node products/titan/dist/bin.js health sample
```

## The problem it solves

The factory's uptime had no record. A probe that ran from a coordinating session cost a
model turn each time, and a shell stopgap kept rows nobody could fold into an uptime figure.
`titan` is the host CLI that samples this host's services from code and keeps every result
in the append-only store from `health`.

The primitive it adds is a **sampling tick**: probe every target in parallel, measure the
sampler's own cost, then write all of it in one transaction. One wakeup and one commit per
minute, whatever the number of targets.

## When to reach for it

Run `titan health sample` once a minute on the host that runs the services (a systemd user
timer on a Linux host). Reach for the [`health`](/reference/health) package instead when
you are building a probe, a store or an uptime report into another product.

## `titan health sample`

```sh
titan health sample [--db <path>]
```

- The store defaults to `$XDG_STATE_HOME/titan/health.sqlite3` (`~/.local/state/titan/`).
- It exits 0 when the tick is stored, whatever the targets answered: a down target is a
  `fail` row, not an error. It exits 2, naming the path, when the store cannot be opened or
  written, because that minute is then missing from the record.
- It makes no model or tool calls and needs no credential. It reads `GET /health` on
  loopback, the target's pid file and the store.

### Targets

The default target is `factory`:

| Field | Value |
|---|---|
| `url` | `http://127.0.0.1:7410/health` |
| `timeoutMs` | 5000 |
| `expectPort` | 7410 |
| identity | the pid in `$XDG_STATE_HOME/titan-factory/daemon.pid` |
| `observe` | `startedAt`, `uptimeSeconds`, `restartCount`, `uncleanStartsTotal`, `restartsToday`, `build.sha`, `version` |

The observed fields are serve's own restart counters. A minutely probe cannot see a restart
that comes back within a few seconds, so the sampler stores what serve reports and never
infers restarts from gaps between samples.

`$XDG_CONFIG_HOME/titan/host.json` can override a target by name or add one:

```json
{ "health": { "targets": [{ "name": "factory", "url": "http://127.0.0.1:7411/health" }] } }
```

An entry may set `url`, `timeoutMs`, `expectPort`, `observe` and `pidStateDir`. A new
name needs a `url`. A missing file leaves the defaults quietly; a file that does not parse
or validate leaves the defaults and prints one line to stderr.

### The self row

Each tick ends with one row for target `titan-health-sampler`, kind `self`, status `pass`.
Its `observed` holds `cpuUserUs`, `cpuSystemUs`, `fsReadBlocks`, `fsWriteBlocks`,
`voluntaryCtx`, `involuntaryCtx`, `maxRssKb`, `wallMs` and `targets`.

## `titan health uptime`

```sh
titan health uptime <target> [--window 24h] [--end <iso>] [--min 0.99] [--json] [--db <path>]
```

- `--window` is `<n>m`, `<n>h` or `<n>d` ending at `--end` (default now). The store is
  opened read-only; a store that cannot be opened exits 2 with its path.
- The report comes from `uptime` in [`health`](/reference/health): slots, up, down,
  unknown and missing, `upShareOfWindow`, `upShareOfObserved` and the gaps. A missing
  minute is never up.
- `restarts` and `uncleanStarts` are the deltas of serve's own `restartCount` and
  `uncleanStartsTotal` between the first and last sample in the window that carries them,
  as `{ first, last, delta, counterReset }`. When a counter drops anywhere in the window
  (serve's state file was reset), `counterReset` is true and `delta` is null rather than
  negative or undercounted.
- Text prints at most 10 gaps, longest first. `--json` prints all of them, oldest first.
- `--min` exits 1 when `upShareOfWindow` is below it; a window with no whole slot counts as 0.

## `titan health cost`

```sh
titan health cost [--window 24h] [--end <iso>] [--json] [--db <path>]
```

It folds the `self` rows in the window: `ticks` (wakeups), then the mean and max per tick
of `wallMs`, `cpuMs` (user plus system), `fsReadBlocks`, `fsWriteBlocks` and
`contextSwitches` (voluntary plus involuntary), the max `maxRssKb`, and `store` from
`storeStats` (rows, bytes, oldest and newest `ts`).

## `titan health import`

```sh
titan health import <jsonl> [--target factory] [--db <path>]
```

It loads the shepherd-health stopgap log. Each line `{ts, up, code, secs, sha, running,
pendingGates}` becomes a sample of `--target` with kind `http`, status `pass` when `up`
else `fail`, `latencyMs` from `secs`, `observed` holding `code`, `build.sha`, `running`
and `pendingGates` when present, and source `import:shepherd-health`. The dedup key is the
sha256 of the file's base name and the raw line, so importing the same file twice gives the
same row count. Lines that do not parse are skipped and counted; it prints the imported,
duplicate and bad counts.

## `titan host doctor`

```sh
titan host doctor [--json]
```

One row per check, in three groups:

| Group | Rows |
|---|---|
| `product` | `active-work doctor --json`, `agent-chat doctor`, `titan-factory service check --json` |
| `cli` | presence and version of `active-work`, `agent-chat`, `titan-factory`, `claude`, `chezmoi`, `gh`, `git`, `node`, `pnpm` |
| `inventory` | presence of every path in the coordination design's section 2 inventory for this platform (`INVENTORY` in `src/host/inventory.ts`) |

- A row is `ok`, `warn`, `fail` or `missing`. A CLI that is not on PATH is `missing`; a
  product doctor that exits non-zero is `fail` with the product's own cause (the factory's
  `cause: message`, active-work's failing checks, agent-chat's last line). active-work
  warnings make its row `warn`.
- A version comes from `--version`. A CLI without one (`titan-factory`) falls back to the
  `package.json` beside its linked bin.
- For the three product CLIs, `expected` is the `version` in the checkout's `package.json`
  under `$TITAN_PROJECTS_ROOT` (default `~/projects`; the factory's is
  `titan-platform/products/factory`). When the linked bin differs, the row is `warn`
  "version mismatch": the stale linked bin a host can keep after a checkout moves on.
- An inventory row is a `stat`, never a read, so a secret's contents are never touched. Its
  detail names the design's categories: (a) code, (b) per-owner configuration, (c) secret,
  (d) per-host delta. A row marked darwin or linux appears on that platform only. An absent
  path is `missing`, or `warn` when the path only exists on some hosts or roles. A `*`
  segment, as in `~/.claude-profiles/*/settings.json`, gives one row per directory under it.
- The inventory leaves out runtime state (each host recreates it), the leak-guard term list
  (any command naming its path is denied), and the active-work and autonomy roots, which the
  product doctors check against their own configured paths.
- It exits 0 when every row is `ok` or `warn`, else 1. `--json` prints
  `{ host, platform, ok, rows: [{ id, group, status, detail, version?, expected? }] }`;
  `hostDoctorReportSchema` in `src/host/doctor.ts` is its schema.
- It never reads a secret and changes nothing.

## `titan config report`

```sh
titan config report [--json] [--host <name>]
titan config report --to https://<console-lan-name>:<port> --token-file <lan.token copy>
```

One row per config surface of the TP-3579 inventory that lives on every host: agent-chat's
`config.json`, `profiles/*.json`, `burndown.config.json`, `seat-watchdog.json`, `hooks.json` and
`ui.token` (under `$AGENT_CHAT_HOME`), the factory config (under `$XDG_CONFIG_HOME`), and
`settings.json` and `.claude.json` for `~/.claude` and every `~/.claude-profiles/*`.

- A row is facts about the file, never its values: `present`, `mode`, `mtime`, and for a file
  that is not secret `bytes` and `sha256`. `ui.token` and `.claude.json` are secret: they are
  stat'd and never opened. A report therefore cannot carry a value a file holds.
- Paths under home are shown `~`-relative, so two hosts' rows for one surface compare by name.
- `--host` defaults to this machine's short host name, lowercased.
- `--to` posts the report to the console's `config.report` over the LAN listener, with the
  token file's contents as the bearer. It must be `https`, and a redirect is refused. A
  self-signed console certificate needs `NODE_EXTRA_CA_CERTS`. The console stores the report and
  shows it in `config.hosts`; nothing in a report is ever applied, and a report older than 25
  hours shows as not reported.
- `--json` prints `{ schema: "titan-config-report/v1", host, platform, reportedAt, surfaces }`.

## What it deliberately does not do

- It does not run as a daemon. A scheduler starts it each minute.
- It does not prune or rewrite the store.
- It does not import from `products/factory`. It reads the factory over loopback HTTP and
  its pid file.

## Gotchas

- Every self-row counter runs from process start, so node's own startup is part of the
  cost. A oneshot pays that startup every minute, so it is the real cost.
- The self row is measured just before the write, so the write itself is not in it.
- A pid file that is missing while the port answers is a `fail`: a stranger's 200 on the
  port must not read as up.

## Where it came from

New in TP-1651. It replaces a Mac-only shell stopgap that wrote JSONL rows and was never
installed on the factory host.

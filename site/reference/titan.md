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

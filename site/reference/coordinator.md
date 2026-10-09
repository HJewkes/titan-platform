# coordinator

**Tier 2.** No titan dependencies. `zod` is a peer dependency.

```sh
npm install @titan-design/coordinator zod
```

Status: 0.1, pure code. The package has no fs, process, network or broker access.

## The problem it solves

Seat files carry front matter (`schema: autonomy-seat/v1`) that several tools read by hand.
This package adds one primitive: `seatConfigSchema`, a zod schema with inferred types, so a
host validates a seat's config the same way everywhere. It also folds a seat's event log
into `SeatState` (`foldSeatEvents`), so seat state is computed from events rather than
hand-kept, and can be tested with no broker running.

The autonomy charter carries front matter too (`schema: autonomy-charter/v1`): the seat
roster, the hub, the hard-stop classes, the scorer defaults, funds and billing pools.
`charterPolicySchema` types it and `parseCharterPolicy` validates it, so generic charter
rules can live in code rather than prose.

## When to reach for it

Use it to validate or type a seat's front matter after you have parsed the YAML yourself.
Loading seat files, jobs and placement are not here; they wait for the host work.

## Example

```ts
import { seatConfigSchema, type SeatConfig } from "@titan-design/coordinator";

const seat: SeatConfig = seatConfigSchema.parse(frontMatterObject);
```

```ts
import { foldSeatEvents } from "@titan-design/coordinator";

const state = foldSeatEvents(
  [
    { kind: "teleport" },
    { kind: "claim", owner: "sx-a", worktree: "/w/one", patterns: ["src/a.ts"] },
    { kind: "background", id: "watch", command: "node watch.js", cwd: "/w/one" },
  ],
  { tmpdir: process.env.TMPDIR },
);
// state.generation === 1; state.errors lists any refused or malformed event
```

```ts
import { parseCharterPolicy } from "@titan-design/coordinator";

const result = parseCharterPolicy(charterFrontMatterObject);
if (!result.ok) {
  // e.g. [{ code: "missing", path: "pools.pool-a.ceiling_five_hour", message: "..." }]
  console.error(result.errors);
}
```

## What it deliberately does not do

It reads no files, parses no YAML and runs nothing. It has no notion of jobs or placement.

## Gotchas

`name`, `prefix`, `pool`, `config_dir`, `concurrency` and `spend` are required; everything
else is optional. Unknown keys pass through (loose objects), so a new seat key never fails
the parse, but it is also not checked. `spend` may be an empty object.

`foldSeatEvents` never throws. An unknown `kind` only bumps `unknownEvents`; a known kind
that fails its schema, or a background command whose cwd or any path argument sits under
`/tmp`, `/private/tmp`, the `tmpdir` option or a `scratchpad` directory, lands in `errors`.
A claim replaces the earlier claim on the same worktree and a hold the earlier hold on the
same target; patterns and reasons are never merged. Pass `$TMPDIR` in yourself: the fold
reads no environment. A literal `$TMPDIR` or `${TMPDIR}` in the command counts as temp
space, and a `tmpdir` under `/var/` also covers its `/private` real path (macOS).

Paths come from a best-effort split of the command on whitespace, quotes, `=` and shell
operators (`>`, `2>`, `|`, `&&`, `;`), with an option glued to a path (`-o/tmp/x`) trimmed.
URLs are skipped. Other variables are not expanded. `errors[].index` counts from the start
of each call's `events`, so a fold resumed with `from` restarts at 0.

`parseCharterPolicy` never throws. It requires `schema`, `seats` (at least one), `hub`,
`hard_stops`, `defaults`, `funds` (with a `default` list) and `pools`. Every hard stop must be
one of `HARD_STOP_CLASSES` (the twelve classes); an unknown class is refused, since a
misspelt one would guard nothing. In `defaults` the scorer terms, `retire_k`, `teleport_k`
and the worktree counts are required; `gate_free_bonus`, `stale_pr_days` and
`heartbeat_cron` are optional. A pool needs `config_dir`, `human_uses`, `ceiling_five_hour`
and `per_day_points`; `reserve_seven_day` and `sonnet_band_points` are optional. Unknown
keys pass through. An error's `code` is `missing` when nothing sits at its `path`, and
`invalid` otherwise.

## Where it came from

New. The fixtures are neutral stand-ins shaped like real seat front matter.

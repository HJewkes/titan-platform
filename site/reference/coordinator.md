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
reads no environment.

## Where it came from

New. The fixtures are neutral stand-ins shaped like real seat front matter.

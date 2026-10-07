# coordinator

**Tier 2.** No titan dependencies. `zod` is a peer dependency.

```sh
npm install @titan-design/coordinator zod
```

Status: 0.1, pure code. The package has no fs, process, network or broker access.

## The problem it solves

Seat files carry front matter (`schema: autonomy-seat/v1`) that several tools read by hand.
This package adds one primitive: `seatConfigSchema`, a zod schema with inferred types, so a
host validates a seat's config the same way everywhere.

## When to reach for it

Use it to validate or type a seat's front matter after you have parsed the YAML yourself.
Loading seat files, jobs and placement are not here; they wait for the host work.

## Example

```ts
import { seatConfigSchema, type SeatConfig } from "@titan-design/coordinator";

const seat: SeatConfig = seatConfigSchema.parse(frontMatterObject);
```

## What it deliberately does not do

It reads no files, parses no YAML and runs nothing. It has no notion of jobs or placement.

## Gotchas

`name`, `prefix`, `pool`, `config_dir`, `concurrency` and `spend` are required; everything
else is optional. Unknown keys pass through (loose objects), so a new seat key never fails
the parse, but it is also not checked. `spend` may be an empty object.

## Where it came from

New. The fixtures are neutral stand-ins shaped like real seat front matter.

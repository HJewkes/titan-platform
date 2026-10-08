# pm

**Tier 2.** No titan dependencies. `zod` is a peer dependency.

```sh
npm install @titan-design/pm zod
```

Status: 0.1, pure code. The package has no fs, process or network access.

## The problem it solves

active-work, the factory and agent-chat each read task records, and each kept its own idea
of a task's shape. This package adds one primitive: `TaskSchema`, a zod schema with the
inferred `Task` type, so every reader validates a task the same way and a new field is
written once.

## When to reach for it

Use it to validate or type a task record after you have parsed its YAML yourself. Loading
task files, loops and the other active-work records are not here yet. For a seat's front
matter use [`coordinator`](/reference/coordinator).

## Example

```ts
import { TaskSchema, type Task } from "@titan-design/pm";

const task: Task = TaskSchema.parse(parsedYamlObject);
```

## What it deliberately does not do

It reads no files, parses no YAML and writes nothing. It has no notion of initiatives or
task numbering.

## Gotchas

`done_at` is required and nullable: an open task carries `done_at: null`, not a missing key.
Dates must be zero-padded `YYYY-MM-DD` strings that exist on the calendar. Parse YAML with a
YAML 1.2 parser such as `yaml`, which keeps `2026-05-10` a string; a YAML 1.1 parser turns
it into a `Date` and the parse fails. The object is strict about types but not about keys:
unknown keys are stripped, not rejected.

## Where it came from

Ported from active-work's `src/schemas/task.ts` with the same fields and refinements. The
tests run active-work's own task fixtures, copied unchanged, and port its schema cases.

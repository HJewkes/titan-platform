# pm

**Tier 2.** No titan dependencies. `zod` is a peer dependency.

```sh
npm install @titan-design/pm zod
```

Status: 0.1, pure code. The package has no fs, process or network access.

## The problem it solves

active-work, the factory and agent-chat each read task records, and each kept its own idea
of a task's shape. This package holds those primitives once, so every reader agrees:

- `TaskSchema`, a zod schema with the inferred `Task` type. A new field is written here once.
- `readEdges(task)`, which returns a task's `{ parent, dep }`.
- `checkEdges(tasks, change)`, which checks a proposed edge change before it is written.
- `CategoryRegistrySchema` and `checkCategories(task, registry)`, which validate a task's
  `kind`, `status`, `cos` and `area` against one registry file.

## When to reach for it

Use it to validate or type a task record after you have parsed its YAML yourself, to read
a task's edges, to check an edge change on write, or to check a task's categories on write. Loading task files, loops and the other
active-work records are not here yet. For a seat's front matter use
[`coordinator`](/reference/coordinator).

## Example

```ts
import { TaskSchema, checkEdges, readEdges, type Task } from "@titan-design/pm";

const task: Task = TaskSchema.parse(parsedYamlObject);
const { parent, dep } = readEdges(task);

const { errors, warnings } = checkEdges(allTasks, { id: task.id, dep: [...dep, "EC-7"] });
if (errors.length > 0) throw new Error(JSON.stringify(errors));
```

## Edges

A task has at most one `parent` (an epic is a task of kind epic; the initiative is the
implicit root) and one `dep` list of unique ids, which may name tasks in any initiative.

`readEdges` takes a field when it is present, even an empty `dep: []`. Without the field it
falls back to tags: `epic:` or `parent:` for the parent (the first one wins) and `dep:` or
`blocked-by:` for deps. A tag value that is not a task id, such as `epic:some-name`, is
skipped. The tag read is a migration fallback, not a lasting path. Tags are for retrieval
only, and the fallback is removed once the edge tags have been migrated to fields.
`blocks:` is never read: it names the inverse edge, which lives on the other task, so only
the migration can turn it into that task's `dep`.

`checkEdges` is pure. It applies the change to the task list (an omitted field keeps the
task's current edges, and `parent: null` clears it) and returns:

| kind | severity | meaning |
|---|---|---|
| `unknown-id` | error | `parent` or a `dep` entry names an id not in the list |
| `cycle` | error | a parent or dep cycle runs through the changed task; `ids` lists it in edge order, starting at the changed task |
| `cross-initiative-parent` | warning | the parent sits in another initiative; allowed until the owner rules on it |

A self-dep or self-parent is a one-task cycle. A cycle elsewhere in the graph that the
change does not touch is not reported.

## Categories

`kind`, `status`, `cos` and `area` are closed sets, and a task holds at most one value of
each (`status` is required). The sets live in one registry file,
`categoriesPath(activeRoot)`, which is `<activeRoot>/titan-platform/categories.yml`:

```yaml
kind: [epic, feature, platform]
status:
  - { id: open, closed: false, dispatchable: true }
  - { id: done, closed: true, dispatchable: false }
  - { id: wont-do, closed: true, dispatchable: false }
  - { id: icebox, closed: false, dispatchable: false }
cos: [standard, fixed]
area:
  - { id: pm, tier: 2, path: packages/pm }
  - { id: relay, tier: product }
```

`CategoryRegistrySchema` requires status `open`, `done`, `wont-do` and `icebox` and kind
`epic`, rejects a repeated id on an axis, and takes ids matching `/^[a-z0-9][a-z0-9-]*$/`.
An area `tier` is `0`, `1`, `2`, `"ui"` or `"product"`, the keys of `$tiers` in
`.codewatch/check.json`. Each status declares `closed` and `dispatchable`, so a dispatcher
reads those flags instead of hard-coding status names.

The host reads the file. `parseCategoryRegistry(parsed)` takes the parsed YAML, or
`undefined` when the file does not exist, which returns `null`. An empty file parses to
`null` and fails, so a registry cannot be switched off by emptying it.

```ts
import { checkCategories, parseCategoryRegistry } from "@titan-design/pm";

const registry = parseCategoryRegistry(exists ? parse(text) : undefined);
const errors = checkCategories(task, registry);
```

`checkCategories` is pure and returns one error per problem:

| kind | meaning |
|---|---|
| `unknown-category` | the value on `axis` is not in the registry; `allowed` lists the values that are |
| `cos-fixed-without-due` | `cos` is `fixed` and the task has no `due` date |

A `null` registry is a root with no categories file. It checks `status` against
`BUILT_IN_STATUSES`, `open` and `done`, the set tasks used before the registry, and skips
`kind`, `cos` and `area`. `cos-fixed-without-due` is checked with or without a registry.
`TaskSchema` itself only requires a non-empty `status` string, so the value is closed by
`checkCategories`, not by the parse. `due` is a `YYYY-MM-DD` date like the others.

## What it deliberately does not do

It reads no files, parses no YAML and writes nothing, the category registry included. It
does not choose the area ids; those come from `$tiers` and the products outside this repo. It has no task numbering, and it
knows a task's initiative only by its id prefix (`EC` for `EC-1`).

## Gotchas

`done_at` is required and nullable: an open task carries `done_at: null`, not a missing key.
Dates must be zero-padded `YYYY-MM-DD` strings that exist on the calendar. Parse YAML with a
YAML 1.2 parser such as `yaml`, which keeps `2026-05-10` a string; a YAML 1.1 parser turns
it into a `Date` and the parse fails. The object is strict about types but not about keys:
unknown keys are stripped, not rejected.

## Where it came from

Ported from active-work's `src/schemas/task.ts` with the same fields and refinements. The
tests run active-work's own task fixtures, copied unchanged, and port its schema cases.

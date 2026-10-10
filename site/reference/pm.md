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
- `DeliverableSchema` and `parseDeliverableRegistry(entries)`, which validate the one
  platform-wide deliverable registry, one file per deliverable.
- `taskTree(tasks, rootId)` and `criticalPath(tasks, { deliverable })`, which read the
  parent tree and the dep graph.

## When to reach for it

Use it to validate or type a task record after you have parsed its YAML yourself, to read
a task's edges, to check an edge change on write, to check a task's categories on write,
or to validate the deliverable files you have read. Loading task files, loops and the other
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

## Deliverables

A deliverable is an outcome that several tasks contribute to. There is one registry for
the whole platform, `deliverablesDir(activeRoot)`, which is
`<activeRoot>/titan-platform/deliverables`, holding one `<id>.yml` per deliverable
(`deliverablePath(activeRoot, id)`):

```yaml
id: console-v1
title: Console v1
done_when: the console shows every active deliverable
target: 2026-11-30
status: active
owner_seat: example-seat
tags: [console]
created: 2026-10-08
updated: 2026-10-08
shipped_at: null
```

An id matches `DELIVERABLE_ID_REGEX`, `/^[A-Za-z][A-Za-z0-9-]*$/`. `target` is a
`YYYY-MM-DD` date or `null`. `status` is one of `DELIVERABLE_STATUSES`: `planned`,
`active`, `shipped` or `dropped`. `shipped_at` is required and nullable like a task's
`done_at`, and it is set exactly when `status` is `shipped`.

Tasks link to deliverables through the optional `deliverables` field, a list of unique
deliverable ids, so the relation is many-to-many. A deliverable's `tags` are for retrieval
only: nothing selects, orders or lints on them, and no code here reads a `deliverable:`
task tag. A test enforces that.

The host reads the directory. `parseDeliverableRegistry(entries)` takes one
`{ file, parsed }` per `.yml` file, `file` being the basename and `parsed` its parsed YAML,
and returns the deliverables in the order given. A missing directory is an empty registry:
pass `[]` and get `[]` back. Each file must be named after the id it holds, which keeps
ids unique. The first bad file throws an error that starts with its name.

```ts
import { deliverablesDir, parseDeliverableRegistry } from "@titan-design/pm";

const dir = deliverablesDir(activeRoot);
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yml")) : [];
const deliverables = parseDeliverableRegistry(
  files.map((file) => ({ file, parsed: parse(readFileSync(join(dir, file), "utf8")) })),
);
```

## Tree and critical path

Both read edges through `readEdges`, so the tag fallback applies to them too, and both keep
the first task when an id repeats.

`taskTree(tasks, rootId)` returns the subtree under `rootId` by `parent` edges, or `null`
when no task has that id. Each node carries `id`, `title`, `status`, `estimate` (`null`
when unestimated), `depth` (0 at the root) and `children` in input order, so a depth-first
walk of `children` prints the tree. A parent cycle is cut where it would revisit a task.

`criticalPath(tasks, { deliverable })` schedules the open tasks by their `dep` edges with
the estimate in points as the duration, and returns the total float of each:

| field | meaning |
|---|---|
| `tasks` | `{ id, duration, earlyStart, earlyFinish, lateStart, lateFinish, float }` per task outside a cycle, in input order |
| `criticalPath` | the zero-float ids, by early start then input order |
| `length` | the longest open chain in points: the latest early finish |
| `cycles` | each dep cycle's ids, in input order; its tasks get no float |
| `lowerBound` | true when there are cycles, since their tasks add nothing to `length` |
| `externalDeps` | `{ task, dep }` for each dep outside the set |
| `unestimated` | ids whose estimate is missing, NaN, infinite or negative |

The rules match agent-chat's burndown critical path:

- The set is the open tasks, narrowed to those whose `deliverables` field lists
  `deliverable` when one is given. No tag is read for this.
- A dep outside the set (a closed task, another deliverable, an unknown id) is satisfied.
- An unestimated task has duration 0 but keeps its edges.
- A cycle is reported, never thrown.

Open means not closed. Until callers pass the category registry in, status `done` and
`wont-do` count as closed and every other status, `icebox` included, as open.

```ts
import { criticalPath } from "@titan-design/pm";

const { criticalPath: path, length, cycles } = criticalPath(allTasks, { deliverable: "console-v1" });
```

## What it deliberately does not do

It reads no files, parses no YAML and writes nothing, the category and deliverable
registries included. It does not check that a task's `deliverables` ids exist. It
does not choose the area ids; those come from `$tiers` and the products outside this repo. It has no task numbering, and it
knows a task's initiative only by its id prefix (`EC` for `EC-1`).

## Actuals and claims

A task may carry an optional `actual` block, the measured outcome written back when the task is
done. Every field is optional and a non-negative number unless noted: `agentHours`,
`reviewAgentHours`, `usd`, `serviceWallHours`, `peakContext`, `contextAtFirstDeliverable`,
`at` (an ISO datetime) and `model` (the hash of the model that produced the figures).

`claimedHours` is an optional list of `{ hours, by, at }`: a free-text estimate logged with the
claiming agent and an ISO datetime, to be scored against `actual` when the work completes. It
is never an input to a forecast.

## Dates and datetimes

`created` and `done_at` (nullable) accept `YYYY-MM-DD` or a full ISO-8601 datetime such as
`2026-10-08T14:03:22Z` (`Z` or a `+hh:mm` offset, optional fractional seconds), because
active-work now writes datetimes while older task files keep a bare date. `started_at` is an
optional write-once ISO datetime. `updated`, `due` and the deliverable dates stay date-only.
`isoDate` is unchanged; `isoDatetime` and `isoDateOrDatetime` are the new validators.

## Gotchas

`done_at` is required and nullable: an open task carries `done_at: null`, not a missing key.
Dates must be zero-padded `YYYY-MM-DD` strings that exist on the calendar. Parse YAML with a
YAML 1.2 parser such as `yaml`, which keeps `2026-05-10` a string; a YAML 1.1 parser turns
it into a `Date` and the parse fails. The object is strict about types but not about keys:
unknown keys are stripped, not rejected.

## Where it came from

Ported from active-work's `src/schemas/task.ts` with the same fields and refinements. The
tests run active-work's own task fixtures, copied unchanged, and port its schema cases.

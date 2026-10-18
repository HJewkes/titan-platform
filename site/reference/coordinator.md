# coordinator

**Tier 2.** Depends on `@titan-design/agent-dispatch` (tier 1) for `limitsSchema`. `zod` is a
peer dependency.

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
roster, the hub, the hard-stop classes and the scorer defaults. `charterPolicySchema` types it and `parseCharterPolicy` validates it, so generic charter
rules can live in code rather than prose.

`HARD_STOPS` catalogues those classes with one detection pattern each, and `hardStopsIn`
names the classes a task's `done_when` (or any text) touches, so every host detects hard
stops the same way. `resolveSeatPolicy` turns the charter and one seat into that seat's
effective hard stops and scorer defaults: the stricter rule wins, and a seat never removes
a global hard stop.

A coordinator for another user needs one document instead of a tree of seat files:
`titan-coordinator/v1`. `coordinatorConfigSchema` composes it from the schemas above and
agent-dispatch's `limitsSchema`, and `checkCoordinatorConfig` checks the references between
its sections.

Changes to that document are a revision log. `applyEdit` sets one schema-declared field on a
copy and re-checks the whole document, `diffDocuments` lists the changed leaves, and
`verifyChain` checks that each revision names the previous one's `revisionSha` as its parent,
so a forked or rewritten log fails.

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
  // e.g. [{ code: "missing", path: "defaults.teleport_k", message: "..." }]
  console.error(result.errors);
}
```

```ts
import { hardStopsIn } from "@titan-design/coordinator";

hardStopsIn("Edit CLAUDE.md, then deploy.");
// ["deploy", "config-edit"]
hardStopsIn("Edit CLAUDE.md, then deploy.", policy.hard_stops.filter((s) => s !== "deploy"));
// ["config-edit"]
```

```ts
import { resolveSeatPolicy } from "@titan-design/coordinator";

const { hard_stops, defaults } = resolveSeatPolicy(policy, seat);
// hard_stops: the charter's list, then the seat's extra_hard_stops
// defaults: the charter's, with the seat's `defaults` and weights merged over them
```

```ts
import { checkCoordinatorConfig } from "@titan-design/coordinator";

const result = checkCoordinatorConfig({
  $schema: "titan-coordinator/v1",
  owner: { seat: "operator", timezone: "UTC", channels: ["console"] },
  repos: { web: { path: "~/src/web", remote: "example/web", default: "main" } },
  seats: {
    operator: { prefix: "op", attended: true, pool: "main",
                concurrency: { implementers: 0, reviewers: 0, planners: 1 }, spend: {} },
    "web-coord": { prefix: "wc", pool: "main", repos: ["web"],
                   concurrency: { implementers: 2, reviewers: 2, planners: 1 }, spend: {} },
  },
  limits: {
    version: 1,
    pools: { main: { config_dir: "~/.claude", ceiling_five_hour: 90, reserve_seven_day: 20 } },
  },
  policy: { hard_stops: ["force-push", "npm-publish"] },
});
// a seat with pool "spare" would give
// { ok: false, errors: [{ code: "reference", path: "seats.web-coord.pool", ... }] }
```

```ts
import { applyEdit, verifyChain } from "@titan-design/coordinator";

const edit = applyEdit(document, "seats.web-coord.concurrency.implementers", 4);
// edit.ok ? edit.document : edit.errors
verifyChain(revisions);
// { ok: true, head } or errors such as { rev: 2, code: "parent", ... }
```

```ts
import { parseAuthored, renderAuthored } from "@titan-design/coordinator";

const result = parseAuthored(seatState.authored);
if (result.ok) {
  const text = renderAuthored(result.block, new Date());
  // "Continuations:\n- on pr owner/repo#12: merge once green\n\nNext/why:\n..."
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
`hard_stops` and `defaults`. Every hard stop must be one of `HARD_STOP_CLASSES` (the twelve
classes); an unknown class is refused, since a misspelt one would guard nothing. In
`defaults` the scorer terms, `retire_k`, `teleport_k` and the worktree counts are required;
`gate_free_bonus`, `stale_pr_days` and `heartbeat_cron` are optional. Unknown keys pass
through. `pools` and `funds` are deliberately not in the schema, because account limits
belong to `@titan-design/agent-dispatch`; they pass through untyped. An error's `code` is
`missing` when nothing sits at its `path`, and `invalid` otherwise.

`hardStopsIn` reports classes in `HARD_STOPS` order, not charter order, and treats a
missing text as empty. The patterns favour a false hit over a miss: a stop-short task costs
a score penalty, a missed hard stop costs an action a person should have taken. They are
keyword patterns, not a parser, so a negation ("do not deploy") still matches. Pass `among`
to report only the classes a charter or seat lists; a name outside `HARD_STOP_CLASSES` in
`among` is ignored.

`resolveSeatPolicy` reads a seat's optional `defaults` (any charter default, each key
replaced whole, so a `retire_k` override names all three roles), its top-level
`kind_weights` and `share_caps` (merged key by key over the charter's, and over the seat's
own `defaults` weights), and its `extra_hard_stops`. Hard stops are a union: the charter's
list in order, then each seat extra not already in it. A `hard_stops` key on the seat is
ignored. `stop_short_factor` is the lower of the charter's and the seat's, because raising
it would disarm every hard stop in the scorer. Extra hard stops are free-form names, not
only `HARD_STOP_CLASSES`. It never mutates its inputs, though the result shares nested
objects with them.

`checkCoordinatorConfig` never throws. A schema failure returns `missing` or `invalid` errors
and skips the reference checks; a document that parses then gets `reference` errors, each
naming its key path. Lookups use own keys only, so a name such as `constructor` is not
found by accident:

- exactly one seat has `attended: true`, and `owner.seat` names it;
- every seat `pool`, `overflow_pool` and `pools[]` entry is a key of `limits.pools`, and so is
  every pool named inside `limits` (`funds`, `seats`, `profiles.<n>.pools` keys, `overrides[].pools`);
- every `limits.seats` key is a seat;
- every seat `repos[]` id is a key of `repos`; a repo used by two or more seats must list
  each of them in its `shared_with`;
- seat prefixes are unique (names are unique because seats are keyed by name);
- no seat has `config_dir`, which lives only on its limits pool;
- every `policy.hard_stop_repos` key is in `policy.hard_stops`, whose entries must be
  `HARD_STOP_CLASSES`.

Seats are `seatConfigSchema` without `schema`, `name`, `config_dir` and `repos`, with `repos`
as ids into the top-level `repos` map. Like the seat and charter schemas the document is
loose: unknown keys pass through on read. `limits` is the exception: agent-dispatch's
`limitsSchema` is strict, so an unknown limits key fails. `policy.defaults` may be partial or
empty.

`parseAuthored` never throws. The 1,500-character cap is on the stored JSON text, checked
before `JSON.parse` (`too-long`); `authoredBlockSchema` applies the same cap to an object
handed in directly, measured as compact JSON without its empty sections. `""` (the cleared
block) and `{}` both read as an empty block. Unlike seat front matter the block is strict: an
unknown key, a continuation `on` other than `agent`, `pr`, `msg` or `time`, an `expires` that
is not a `YYYY-MM-DD` date, or a `next_why` over 5 lines is refused at its key path. Expiry is
checked at render, not at parse: `renderAuthored` keeps a standing rule through its `expires`
day and drops it once `now`'s UTC day is later. Empty sections are omitted, so an empty block
renders as `""`.

## Where it came from

New. The fixtures are neutral stand-ins shaped like real seat front matter.

# authority

**Tier 0 · primitives.** No titan dependencies; `zod` is a peer dependency.

```sh
npm install @titan-design/authority zod
```

## The problem it solves

Agents, headless runs and automation all act with the owner's credentials, so nothing on
the remote side can tell who merged a pull request, published a package or engaged a
device. Each tool that wanted a rule grew its own deny list, and the lists drifted.

This package holds one decision table as data. For every action class and actor class it
names exactly one verdict: `allow`, `gate` (proceed only after a listed owner class
resolves an approval gate) or `deny`. `evaluate` looks a request up in the table, and
`canResolve` says whether a would-be resolver may resolve the gate a rule opens.
`policyTableSchema` rejects a table that misses a pair, repeats a pair, or names anyone
but the owner as a resolver.

## When to reach for it

Any enforcement point that must decide whether an actor may do something: a PreToolUse
hook, a workflow step before a merge or a device action, a spawn path, a gate resolver.
Import the table and call `evaluate`; a plain-node hook can read
`@titan-design/authority/table.json` directly without a build step. The gate itself is
[hitl](./hitl.md); this package only decides whether one is needed and who may close it.

## Example

Verified against 0.0.0 (table version 1.0.0).

```ts
import { DEFAULT_TABLE, canResolve, evaluate } from "@titan-design/authority";

const actor = { class: "coordinator" as const, id: "hermes" };

evaluate(DEFAULT_TABLE, { action: "merge", actor, tainted: false, subject: { repo: "titan-platform", pr: "12" } });
// { verdict: "gate", ruleId: "MRG-CO", resolvers: ["owner-terminal", "owner-remote"], reason: "..." }

evaluate(DEFAULT_TABLE, { action: "spawn", actor, tainted: true, subject: {} });
// { verdict: "gate", ruleId: "SPN-CO", resolvers: ["owner-terminal"], reason: "..." }

canResolve(DEFAULT_TABLE, "MRG-CO", { class: "coordinator", tainted: false }); // false: agents never resolve
canResolve(DEFAULT_TABLE, "MRG-CO", { class: "owner-remote", tainted: false }); // true
```

## The vocabulary

Actor classes, classified by the process that performs the action, never by what a model
claims: `owner-terminal` (OT), `owner-remote` (OR, a verified phone, voice or Matrix
channel), `coordinator` (CO), `worker` (WK), `headless` (HD, a daemon-dispatched run) and
`automation` (AU, CI and other non-agent processes).

`RESOLVER_CLASSES` lists the owner classes that may resolve a gate. `DELEGATE_RESOLVER_CLASSES`
(`coordinator` only) lists the classes a gate's rule may name as a delegate resolver. A hitl
store admits a delegate only when it has `authorize` and `authorize` allows it.

A session is **tainted** once untrusted content (web pages, issue text, third-party
messages) enters its context. Taint is sticky and inherited on spawn. A rule marked T turns
`allow` into a gate that only the owner at a terminal resolves; in table 1.0.0 only
`spawn` by a coordinator escalates. `private-egress` by a coordinator also carries the
marker but is already `deny`. A tainted session never resolves a gate.

## The table (version 1.0.0)

42 allow, 6 gate and 44 deny rows: one unconditional row per pair, plus the two conditional
allow rows MRG-AU-RV and MRG-AU-RC described below. Each rule also carries an optional `condition` that
qualifies the verdict in words, such as "inside its own worktree", and the evidence kinds
the enforcing code should record.

| Action | OT | OR | CO | WK | HD | AU |
|---|---|---|---|---|---|---|
| `merge` | allow | gate (OR) | gate (OT, OR) | deny | deny | gate (OT, OR); allow by MRG-AU-RV or MRG-AU-RC |
| `release` | allow | deny | gate (OT) | deny | deny | allow |
| `secret-read` | allow | deny | deny | deny | deny | allow |
| `untrusted-ingest` | allow | allow | allow | allow | allow | allow |
| `private-to-public` | allow | deny | deny | deny | deny | deny |
| `private-egress` | allow | allow | deny T | deny | deny | allow |
| `hardware-actuate` | allow | deny | gate (OT) | deny | deny | deny |
| `hardware-stop` | allow | allow | allow | allow | allow | allow |
| `destructive-remote` | allow | deny | deny | deny | deny | deny |
| `destructive-local` | allow | deny | allow | allow | allow | allow |
| `destructive-foreign` | allow | deny | deny | deny | deny | deny |
| `spawn` | allow | allow | allow T | deny | deny | allow |
| `spend-over-cap` | allow | deny | allow | allow | allow | allow |
| `authority-config` | allow | deny | deny | deny | deny | deny |
| `human-verb` | allow | gate (OR) | deny | deny | deny | deny |

### Conditional rows

A rule with `when` applies only when every listed condition holds on the request's
`facts`; otherwise `evaluate` falls back to the pair's unconditional rule and names the
unmet conditions in the reason. Only an `allow` rule may carry `when`, and conditional rows
do not count toward totality. `unmetConditions(when, facts)` returns the failing ones.

MRG-AU-RV (owner decision D-A, all seats) allows an automation merge when:

- the verdict's author is the reviewer the run dispatched, matched on agent id and session id;
- the verdict is `MERGE` and names the exact head, a full 40-character lower-case sha compared
  exactly (no prefix or case folding);
- every required context has a `success` check run at that head from an allowed app
  (`neutral` or `skipped` does not satisfy a required context);
- no check run at that head from an allowed app is failed, cancelled or still running, and
  every check run is well formed (a name, an integer app id, a head sha and a conclusion);
- the merge-tree is clean and the repo is not frozen;
- no changed path is `CODEOWNERS`, `docs/CODEOWNERS`, `.github/CODEOWNERS` or `.gitmodules`, compared
  case-insensitively. Paths under `.github/` are not protected, by the owner decision of
  2026-10-07 (TP-1886). A path that is not canonical (a backslash,
  a leading, trailing or doubled `/`, a `.` or `..` segment, a segment ending in a space
  or a dot, or any character outside printable ASCII) counts as protected, and an empty `changedPaths` fails;
- the seat grants `merge-on-green-approve`.

MRG-AU-RC allows the same automation merge for a head that carries the reviewer's MERGE
across a tree-equal update-branch. It keeps every MRG-AU-RV condition except
`verdict-merge-at-head`, and adds `verdict-merge-carried-tree-equal`: the verdict is `MERGE`,
the optional `carry` fact names that verdict's head as `carry.fromHead` and `facts.head` as
`carry.head`, both full 40-character lower-case shas, and `carry.headTree` equals
`carry.mergeTree`. The caller fills `carry` from its tree-equality probe, never from reviewer
text. It is a separate row so that deleting it revokes carrying and leaves MRG-AU-RV as it
was. It also requires `pr-kind-not-security`: the optional `kind` fact, which the caller
reads from the run's registration, must be `correctness`, `feature` or `refactor`. The row
never carries `kind: security` and fails closed on an unknown or missing kind. MRG-AU-RV
does not read `kind`.

A request with no `facts` fails every condition, and a conditional row matches only when
`tainted` is an own property set to exactly `false`; an inherited `false`, or any other value (`true`, missing, `null`, `0`, `""`) is
treated as tainted, so all of these get the MRG-AU gate. Every fact is attested by the caller, so a
trusted collector, never the requesting session, must gather them. Its `changedPaths`
must list both the source and the target of every rename. `evaluate` reads each
request field exactly once. It copies the facts with `structuredClone` inside a guard and
rebuilds the copy as plain data on null-prototype objects, so a polluted `Object.prototype`
cannot supply a missing fact. Facts holding a function, a `toJSON` method, a Proxy, a Map, a Set, a Date, a BigInt, a cycle or a throwing getter fail every condition, and so does
a sparse array, because a hole would read through to a possibly polluted prototype. The
rebuild reads own properties only. A class instance is copied as its own data, without its
prototype. A value the caller did not set as an own property may make a decision more
restrictive, never less: an inherited or getter-supplied truthy `tainted` still
escalates a `taintEscalates` row, and inherited `facts` are ignored. `evaluate` trusts the request object itself: a Proxy request whose traps report an own `tainted: false` is treated as untainted, because a caller that builds such a request is asserting that value. A missing or malformed fact fails its condition rather than
throwing: booleans must be exactly `true` or `false`, ids
non-empty strings compared exactly, and lists real arrays matched by exact element. `allowedApps` is caller-supplied: the package
pins no app id, so Shepherd must pin GitHub Actions (app id 15368) itself. The row
decides; it does not resolve a hitl gate. hitl refuses an `automation` resolver, so a
caller evaluates first and opens a gate only when the decision is `gate`.

```ts
evaluate(DEFAULT_TABLE, {
  action: "merge", actor: { class: "automation", id: "shepherd" }, tainted: false, subject: {},
  facts: { merge: { head, resolver, dispatchedReviewer, verdict, requiredContexts, allowedApps: [15368],
    checkRuns, mergeTreeClean: true, repoFrozen: false, changedPaths, seatGrants } },
});
// { verdict: "allow", ruleId: "MRG-AU-RV" } when every condition holds
```

Spend is monitored, not capped: `spend-over-cap` is allowed for every local actor, with
the spend recorded and a notice to the owner at a threshold. Only raising a cap remotely
is denied.

## What it deliberately does not do

It enforces nothing. It has no hooks, spawns no processes, and does no file or network
access. It does not decide whether a session is tainted or which class an actor belongs
to; the caller classifies, and the table decides. It opens no gates and writes no
records: `evidence` names what a consumer should record, not a store.

## Gotchas

`evaluate` denies any pair the table does not name, with `ruleId: null`, so a typo in an
action string is a refusal rather than an exception. `DEFAULT_TABLE` is parsed through
`policyTableSchema` on import, so an invalid `table.json` fails at load. A gate decision
lists the resolvers; checking a real resolver still needs `canResolve`, which is where
taint and agent classes are refused.

## Where it came from

MRG-AU-RV was added in TP-461 for the Shepherd merge path, and MRG-AU-RC in TP-778. The rest is new in TP-400, the first slice of the software-factory authority policy (TP-380). The rows
are the owner-approved table of 2026-09-28, including the change that makes spend
monitor-only.

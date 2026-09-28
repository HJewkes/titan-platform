# @titan-design/authority

The owner-approved authority decision table as data, with its zod schema and a pure
evaluator. For every action class (merge, release, secret read, spawn, hardware actuation
and more) and every actor class (owner at a terminal, owner remote, coordinator, worker,
headless run, automation) the table names exactly one verdict: `allow`, `gate` or `deny`.

Tier 0 of the titan-platform DAG. No titan dependencies, no Node built-ins; `zod` is a peer
dependency.

```ts
import { DEFAULT_TABLE, canResolve, evaluate } from "@titan-design/authority";

evaluate(DEFAULT_TABLE, { action: "merge", actor: { class: "worker", id: "w1" }, tainted: false, subject: {} });
// { verdict: "deny", ruleId: "MRG-WK", reason: "MRG-WK denies merge by worker" }

canResolve(DEFAULT_TABLE, "MRG-CO", { class: "coordinator", tainted: false }); // false
```

- `evaluate(table, request)`: the decision for one request. No matching rule means deny.
  A tainted actor on a rule marked `taintEscalates` gets a gate only the owner at a
  terminal resolves.
- `canResolve(table, ruleId, resolver)`: false for any agent or automation class and for
  any tainted resolver.
- `policyTableSchema`: rejects a table that misses or repeats an action by actor pair, or
  names anyone but `owner-terminal` or `owner-remote` as a resolver.
- `DEFAULT_TABLE`: the approved table, also shipped as `@titan-design/authority/table.json`
  for plain-node hooks.

The library enforces nothing by itself. See the reference page for the full table.

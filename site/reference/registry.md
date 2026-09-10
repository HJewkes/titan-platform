# registry

**Tier 1 · engines.** No titan dependencies. `zod` v4 is a peer.

```sh
npm install @titan-design/registry zod
```

## The problem it solves

A tool that has a CLI, an MCP server, and an HTTP API usually has three descriptions of
every command: a commander definition, a JSON Schema for MCP, and a route handler. They
drift, and the drift is invisible until a user hits it.

Define the command once with zod. The CLI, the MCP tool list, and the HTTP route become
projections of that one definition.

## When to reach for it

You are building anything with more than one surface, or you expect a second surface later.
It is 65 lines of concept and the cheapest package here to adopt: it depends on nothing but
zod, and the [binding pattern](/guides/binding-pattern) keeps your call sites unchanged.

## Example

Verified against 0.1.0.

```ts
import { z } from "zod";
import {
  EXIT,
  commandToTool,
  createRegistry,
  defineCommand,
  invokeCommand,
  toolNameToCommandName,
  type BaseContext,
} from "@titan-design/registry";

interface Ctx extends BaseContext {
  root: string; // product-specific fields extend BaseContext
}

const registry = createRegistry<Ctx>();

const taskDone = defineCommand<{ slug: string; force?: boolean }, { ok: true }, Ctx>({
  name: "task.done",
  description: "Mark a task done",
  args: z.object({ slug: z.string(), force: z.boolean().optional() }),
  result: z.object({ ok: z.literal(true) }),
  cli: { positional: ["slug"], options: { force: { long: "--force", description: "Skip checks" } } },
  async run(args) {
    return { ok: true };
  },
});

registry.register(taskDone);

const ctx = { warnings: [], format: "json", root: "/tmp/x" } satisfies Ctx;

await invokeCommand(taskDone, { slug: "TP-1" }, ctx, { invalidArgsCode: EXIT.USAGE });
// { envelope: { ok: true, data: { ok: true } }, exitCode: 0 }
// (a `warnings` array appears only when the command pushed one onto ctx.warnings)

await invokeCommand(taskDone, { slug: 3 }, ctx, { invalidArgsCode: EXIT.USAGE });
// { envelope: { ok: false,
//               error: 'Invalid arguments: slug: Invalid input: expected string, received number',
//               code: 64 }, exitCode: 64 }

commandToTool(taskDone, { prefix: "miner__" }).name;             // 'miner__task__done'
toolNameToCommandName("miner__task__done", { prefix: "miner__" }); // 'task.done'
```

`invokeCommand` validates, runs, and **always returns an envelope. It never throws.** Thrown
errors map to a code through their numeric `code` property by default; pass `formatError` to
use your own error hierarchy.

## The projections

**CLI.** Commander-free helpers, so the product owns the commander wiring:
`commandPath("task.done")` gives the sub-command path, `positionalSpec` gives `<slug>` or
`[slug]` from the schema, `optionFlagSpec` gives `--force` or `--x <value>`, and
`collectCliArgs` reads commander's parsed values back into an args record, coerced by schema
kind.

**MCP.** `commandToTool` builds the descriptor; `inputSchema` comes from zod 4's native
`toJSONSchema` with `$schema` and `definitions` stripped, because some MCP clients reject
them at the root. Tool names are `${prefix}${command.replaceAll(".", "__")}`.

**HTTP.** [`daemon`](/reference/daemon) mounts `POST /rpc/:name` over the same
`invokeCommand`, so the envelope and exit codes are identical on every surface.

## Gotchas

**`createRegistry()` returns an instance, not a module singleton.** Each product owns its
registry. `register` throws on a duplicate name.

**`list()` is sorted by name**, so help output and tool lists do not depend on import order.
If you are migrating from an insertion-ordered map, your golden files will move.

**Commander's `--no-*` negation stores `false` under the positive key** and never defines
the `noX` key. `collectCliArgs` handles it. This is not hypothetical: a real product shipped
a `--no-loops` flag that was inert for exactly this reason, and the regression test for it
lives in this package.

**Repeatable array options are a gap.** Products currently work around it with a
comma-separated value.

## Where it came from

active-work's `src/registry/` (~65 lines, zod to CLI/MCP/HTTP) — the cleanest unit in the
audit. active-work now consumes it; see
[the adoption case study](/guides/adopting-a-package).

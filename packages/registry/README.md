# @titan-design/registry

Define a command once with zod, then project it onto every surface: a CLI, an MCP tool
list, or an HTTP RPC route. One definition, no parallel schema maintenance.

Tier 1 of the titan-platform DAG. Extracted from active-work's `src/registry/` (TP-2).
Depends only on `zod` (peer, v4).

## Define and register

```ts
import { z } from "zod";
import { createRegistry, defineCommand, type BaseContext } from "@titan-design/registry";

interface Ctx extends BaseContext {
  root: string; // product-specific fields extend BaseContext
}

const registry = createRegistry<Ctx>();

registry.register(
  defineCommand<{ slug: string; force?: boolean }, { ok: true }, Ctx>({
    name: "task.done",
    description: "Mark a task done",
    args: z.object({ slug: z.string(), force: z.boolean().optional() }),
    result: z.object({ ok: z.literal(true) }),
    cli: { positional: ["slug"], options: { force: { long: "--force", description: "Skip checks" } } },
    async run(args, ctx) { /* ... */ return { ok: true }; },
  }),
);
```

`createRegistry()` returns an instance, not a module singleton, so each product owns its
registry. `register` throws on a duplicate name; `list()` is sorted for stable output.

## Invoke from any surface

```ts
import { invokeCommand, EXIT } from "@titan-design/registry";

const { envelope, exitCode } = await invokeCommand(cmd, rawArgs, ctx, {
  invalidArgsCode: EXIT.USAGE, // CLIs; servers default to EXIT.DATAERR
});
```

`invokeCommand` validates with the command's zod schema, runs it, and always returns a
JSON envelope (`{ ok: true, data, warnings? }` or `{ ok: false, error, code }`). It never
throws. Thrown errors map to a code through their numeric `code` property by default;
pass `formatError` to use your own error hierarchy.

## CLI projection

Commander-free helpers so the product owns the commander wiring:

- `commandPath("task.done")` gives the sub-command path.
- `positionalSpec(cmd, "slug")` gives `<slug>` or `[slug]` depending on the schema.
- `optionFlagSpec(cmd, "force", opt)` gives `--force` for booleans, `--x <value>` otherwise.
- `collectCliArgs(cmd, positionals, opts)` reads commander's parsed values back into the
  args record, coerced by schema kind. It handles commander's `--no-*` negation, which
  stores `false` under the stem and never defines the `no*` key.

## MCP projection

```ts
import { commandToTool, toolNameToCommandName } from "@titan-design/registry";

const naming = { prefix: "active__" };
const tools = registry.list().map((cmd) => commandToTool(cmd, naming));
const name = toolNameToCommandName("active__task__done", naming); // "task.done"
```

`inputSchema` comes from zod 4's native `toJSONSchema`, with `$schema` and `definitions`
stripped because some MCP clients reject them at the root.

## Schema introspection

`unwrapSchema`, `schemaKind`, `fieldSchema`, and `isOptionalField` use zod 4's public
`instanceof` classes and `def`, not the `_zod` internals the original dispatcher reached
into. A `.default()` field counts as optional input.

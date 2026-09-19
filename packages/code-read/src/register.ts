import { defineCommand, type AnyCommand, type BaseContext, type CliMeta, type CommandRegistry } from "@titan-design/registry";
import { createLiveSource, type CodeReadDeps, type LiveSource } from "./live-source.js";
import { QUERIES, type QueryFn } from "./query/commands.js";
import { COMMAND_NAMES, CONTRACT, type CommandName } from "./query/contract.js";
import type { ReadSource } from "./query/source.js";

const CLI: Partial<Record<CommandName, CliMeta>> = {
  "snapshot.list": {
    options: {
      ref: { long: "--ref", description: "Only snapshots of this ref" },
      limit: { long: "--limit", description: "Most snapshots to return (default 50, max 500)" },
    },
  },
};

function defineOne<Ctx extends BaseContext>(source: ReadSource, name: CommandName): AnyCommand<Ctx> {
  const { description, args, result } = CONTRACT[name];
  const query = QUERIES[name] as QueryFn<CommandName>;
  return defineCommand<unknown, unknown, Ctx>({
    name,
    description,
    args,
    result,
    cli: CLI[name],
    run: (parsed) => Promise.resolve(query(source, parsed as never)),
  });
}

/**
 * One registry command per contract entry, answering from `source`. Exposed so a product can
 * register a subset on a second registry, for example an MCP-only one, until the registry filters surfaces.
 */
export function defineCodeReadCommands<Ctx extends BaseContext = BaseContext>(source: ReadSource): AnyCommand<Ctx>[] {
  return COMMAND_NAMES.map((name) => defineOne<Ctx>(source, name));
}

/** Register every read command on a product's registry over a live store; returns the source for inspection. */
export function registerCodeReadCommands<Ctx extends BaseContext>(
  registry: CommandRegistry<Ctx>,
  deps: CodeReadDeps,
): LiveSource {
  const source = createLiveSource(deps);
  for (const cmd of defineCodeReadCommands<Ctx>(source)) registry.register(cmd);
  return source;
}

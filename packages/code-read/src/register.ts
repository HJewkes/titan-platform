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
  "hierarchy.get": {
    options: {
      snapshot: { long: "--snapshot", description: "Snapshot id or ref name (default: newest)" },
      root: { long: "--root", description: "Node id to start from; a directory id ends in / (default: the repo)" },
      depth: { long: "--depth", description: "Levels below the root (default 2, max 8)" },
      metrics: { long: "--metric", description: "Metric to report; repeatable (default loc)" },
      baseline: { long: "--baseline", description: "Snapshot id or ref to compute deltas against" },
      include_symbols: { long: "--include-symbols", description: "Descend into symbols below files" },
      exclude_roles: { long: "--exclude-role", description: "Leave out files with this role; repeatable" },
    },
  },
  "node.get": {
    positional: ["id"],
    options: {
      snapshot: { long: "--snapshot", description: "Snapshot id or ref name (default: newest)" },
      baseline: { long: "--baseline", description: "Snapshot id or ref to compute deltas against" },
      metrics: { long: "--metric", description: "Metric to report; repeatable (default: every one that applies)" },
    },
  },
  "node.resolve": {
    positional: ["query"],
    options: {
      snapshot: { long: "--snapshot", description: "Snapshot id or ref name (default: newest)" },
      path: { long: "--path", description: "A file path instead of a query" },
      line: { long: "--line", description: "With --path: resolve to the innermost symbol containing this line" },
      limit: { long: "--limit", description: "Most candidates (default 10, max 50)" },
    },
  },
  "findings.list": {
    options: {
      snapshot: { long: "--snapshot", description: "Snapshot id or ref name (default: newest)" },
      baseline: { long: "--baseline", description: "Snapshot id or ref to give each finding a status against" },
      scope: { long: "--scope", description: "Node id; only findings on it or under it" },
      rule: { long: "--rule", description: "Only this rule; repeatable" },
      severity: { long: "--severity", description: "Only this severity; repeatable" },
      tool: { long: "--tool", description: "Only this tool; repeatable" },
      provenance: { long: "--provenance", description: "Only measured, derived, or model findings; repeatable" },
      kind: { long: "--kind", description: "Only findings on nodes of this kind; repeatable" },
      status: { long: "--status", description: "With --baseline: new, carryover, resolved, worsened, or improved; repeatable" },
      sort: { long: "--sort", description: "severity (default), excess, value, path, or rule" },
      order: { long: "--order", description: "desc (default) or asc; flips the sort key only" },
      offset: { long: "--offset", description: "Rows to skip (default 0)" },
      limit: { long: "--limit", description: "Rows to return (default 20, max 500; 0 for counts only)" },
      facets: { long: "--facets", description: "Also count rows per rule, severity, tool, provenance, kind, and child" },
    },
  },
  "finding.get": {
    positional: ["id"],
    options: {
      snapshot: { long: "--snapshot", description: "Snapshot id or ref name (default: newest)" },
      baseline: { long: "--baseline", description: "Snapshot id or ref for status and the baseline value" },
      context_lines: { long: "--context-lines", description: "Lines of context either side of the flagged range (default 5, max 20)" },
    },
  },
  "node.neighbors": {
    positional: ["id"],
    options: {
      snapshot: { long: "--snapshot", description: "Snapshot id or ref name (default: newest)" },
      direction: { long: "--direction", description: "in, out, or both (default)" },
      edge_kinds: { long: "--edge-kind", description: "Only this edge kind; repeatable (default: all but references, except for a symbol)" },
      metrics: { long: "--metric", description: "Neighbour metric to report; repeatable (default loc and utilization)" },
      offset: { long: "--offset", description: "Edges to skip on each side (default 0)" },
      limit: { long: "--limit", description: "Edges per side (default 20, max 100)" },
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

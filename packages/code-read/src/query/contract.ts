import { toJSONSchema, z, type ZodType } from "zod";
import { Capabilities, MetricDescriptor, RuleSummary, SnapshotInfo } from "./schemas.js";
import { HIERARCHY_GET, NODE_GET, NODE_RESOLVE } from "./contract-nodes.js";

/** The read API's semver. Bump it whenever `CONTRACT` changes; `contract.lock.json` records the last one. */
export const CODE_READ_API_VERSION = "0.1.1";

export interface CommandContract<Args extends ZodType = ZodType, Result extends ZodType = ZodType> {
  description: string;
  args: Args;
  result: Result;
}

const describeArgs = z.object({});
const describeResult = z.object({
  api: z.string(),
  dataset: z.enum(["live", "static"]),
  commands: z.array(z.string()),
  newest: SnapshotInfo.nullable(),
  indexVersions: z.array(z.string()),
  capabilities: Capabilities,
  metrics: z.array(MetricDescriptor),
  rules: z.array(RuleSummary),
});

const snapshotListArgs = z.object({
  ref: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).default(50),
});
const snapshotListResult = z.object({ snapshots: z.array(SnapshotInfo) });

// The lock sees JSON Schema only: a .refine(), .superRefine(), or .transform() here changes behaviour without a lock diff.
/** The single source of command names, argument schemas, and result schemas for every surface. */
export const CONTRACT = {
  "api.describe": {
    description:
      "Contract version, commands served, capabilities, the newest snapshot, and the metric and rule catalogues. Call first to pin compatibility.",
    args: describeArgs,
    result: describeResult,
  },
  "snapshot.list": {
    description: "Indexed snapshots, newest first, with ref, commit, time, and index version. Optionally one ref only.",
    args: snapshotListArgs,
    result: snapshotListResult,
  },
  "hierarchy.get": HIERARCHY_GET,
  "node.get": NODE_GET,
  "node.resolve": NODE_RESOLVE,
} as const satisfies Record<string, CommandContract>;

export type CommandName = keyof typeof CONTRACT;
export type CommandArgs<N extends CommandName> = z.output<(typeof CONTRACT)[N]["args"]>;
export type CommandInput<N extends CommandName> = z.input<(typeof CONTRACT)[N]["args"]>;
export type CommandResult<N extends CommandName> = z.output<(typeof CONTRACT)[N]["result"]>;

/** Name to input args and result: the shape a typed client (`rpc-protocol`'s `CommandMap`) needs. */
export type CodeReadCommandMap = { [N in CommandName]: { args: CommandInput<N>; result: CommandResult<N> } };

export const COMMAND_NAMES = Object.keys(CONTRACT).sort() as CommandName[];

/** The agent-shaped commands the design puts on MCP; `hierarchy.get` is UI-shaped. A product filters with this until the registry can (P3). */
export const AGENT_COMMANDS: readonly CommandName[] = ["api.describe", "node.get", "node.resolve"];

export interface SerializedContract {
  api: string;
  commands: Record<string, { args: unknown; result: unknown }>;
}

/** Args and results as JSON Schema in a stable key order; descriptions are docs, not contract, so they are left out. */
export function serializeContract(): SerializedContract {
  const commands: SerializedContract["commands"] = {};
  for (const name of COMMAND_NAMES) {
    const { args, result } = CONTRACT[name];
    commands[name] = { args: toJSONSchema(args, { io: "input" }), result: toJSONSchema(result) };
  }
  return { api: CODE_READ_API_VERSION, commands };
}

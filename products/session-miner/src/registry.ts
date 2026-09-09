import { createRegistry, type CommandRegistry } from "@titan-design/registry";
import { drainIngest, drainTemplates } from "./commands/drain.js";
import { playbookAdd, playbookRecall, playbookReflect, playbookStatus } from "./commands/playbook.js";
import { refresh } from "./commands/refresh.js";
import { search } from "./commands/search.js";
import { sessionList, sessionShow } from "./commands/sessions.js";
import { status } from "./commands/status.js";
import type { MinerContext } from "./context.js";

export const MINER_VERSION = "0.1.0";
export const TOOL_PREFIX = "miner__";

/** Every command the miner exposes, on every surface. Serve/mcp are wired by the CLI, not registered. */
export function createMinerRegistry(): CommandRegistry<MinerContext> {
  const registry = createRegistry<MinerContext>();
  const commands = [refresh, status, search, sessionList, sessionShow, drainIngest, drainTemplates, playbookAdd, playbookRecall, playbookReflect, playbookStatus];
  for (const cmd of commands) registry.register(cmd);
  return registry;
}

import { EXIT, createRegistry, errorEnvelope, invokeCommand, type BaseContext, type CommandRegistry } from "@titan-design/registry";
import { buildSnapshot, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { consoleCommands, type ConsoleSources } from "./commands.js";

export function createConsoleRegistry(sources: ConsoleSources): CommandRegistry<BaseContext> {
  const registry = createRegistry<BaseContext>();
  for (const command of Object.values(consoleCommands(sources))) registry.register(command);
  return registry;
}

export function createContext(): BaseContext {
  return { warnings: [], format: "json" };
}

/** The calls the shell makes on first paint; an exported page answers exactly these. */
const FIRST_PAINT_CALLS = [
  { command: "upstreams.health", args: {} },
  { command: "work.portfolio", args: {} },
];

/** Answers the first-paint calls in process, for a page that opens from disk with no daemon. */
export async function recordFirstPaint(registry: CommandRegistry<BaseContext>): Promise<Snapshot> {
  const call: DataSource["call"] = async (name, args) => {
    const command = registry.get(name);
    if (!command) return errorEnvelope(`Unknown command: ${name}`, EXIT.USAGE);
    return (await invokeCommand(command, args, createContext())).envelope;
  };
  return buildSnapshot({ call }, { calls: FIRST_PAINT_CALLS });
}

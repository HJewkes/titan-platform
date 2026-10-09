import type { RequestAuth, Surface } from "@titan-design/daemon";
import { EXIT, createRegistry, errorEnvelope, invokeCommand, type CommandRegistry } from "@titan-design/registry";
import { buildSnapshot, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { consoleCommands, type ConsoleSources } from "./commands.js";
import { readCommand, type ClassedCommand, type ConsoleContext } from "./owner-guard.js";

/** Every command carries a class; the console's own commands are all reads. `extra` adds classed commands beside them. */
export function createConsoleRegistry(sources: ConsoleSources, extra: readonly ClassedCommand[] = []): CommandRegistry<ConsoleContext> {
  const registry = createRegistry<ConsoleContext>();
  for (const command of Object.values(consoleCommands(sources))) registry.register(readCommand(command));
  for (const command of extra) registry.register(command);
  return registry;
}

/** The daemon's `createContext`: the auth record the LAN gate kept, and the owner-writes switch. */
export function consoleContextFor(ownerWrites: boolean): (surface: Surface, auth?: RequestAuth) => ConsoleContext {
  return (surface, auth) => ({ warnings: [], format: "json", surface, auth: auth ?? null, ownerWrites });
}

function inProcessContext(): ConsoleContext {
  return { warnings: [], format: "json", surface: "in-process", auth: null, ownerWrites: false };
}

/** The calls the shell makes on first paint; an exported page answers exactly these. */
const FIRST_PAINT_CALLS = [
  { command: "upstreams.health", args: {} },
  { command: "work.portfolio", args: {} },
];

/** Answers the first-paint calls in process, for a page that opens from disk with no daemon. */
export async function recordFirstPaint(registry: CommandRegistry<ConsoleContext>): Promise<Snapshot> {
  const call: DataSource["call"] = async (name, args) => {
    const command = registry.get(name);
    if (!command) return errorEnvelope(`Unknown command: ${name}`, EXIT.USAGE);
    return (await invokeCommand(command, args, inProcessContext())).envelope;
  };
  return buildSnapshot({ call }, { calls: FIRST_PAINT_CALLS });
}

import { runDaemonUntilSignal, runMcpStdio, startDaemon, type DaemonHandle, type StartDaemonOptions } from "@titan-design/daemon";
import { createMinerContext, type MinerContext } from "./context.js";
import type { MinerConfig } from "./config.js";
import { MINER_VERSION, TOOL_PREFIX, createMinerRegistry } from "./registry.js";
import { status } from "./commands/status.js";

export interface ServeOptions {
  port?: number;
  host?: string;
}

/** Everything the daemon needs; exported so tests can start it on an ephemeral port. */
export function serveOptions(config: MinerConfig, options: ServeOptions = {}): StartDaemonOptions<MinerContext> {
  const registry = createMinerRegistry();
  const health = createMinerContext(config);
  return {
    registry,
    createContext: () => createMinerContext(config),
    version: MINER_VERSION,
    stateDir: config.stateDir,
    port: options.port,
    host: options.host,
    toolPrefix: TOOL_PREFIX,
    mcpName: "titan-session-miner",
    health: () => summarize(health),
    watchRoot: config.stateDir,
  };
}

function summarize(ctx: MinerContext): Record<string, unknown> {
  try {
    const graph = ctx.graph();
    const sessions = (graph.db.prepare("SELECT (SELECT count(*) FROM session) + (SELECT count(DISTINCT conversation_ref) FROM normalized_source) AS n").get() as { n: number }).n;
    return { sessions, ftsOrphanRatio: graph.spans.orphanRatio() };
  } catch (err) {
    return { indexError: err instanceof Error ? err.message : String(err) };
  }
}

export function startMiner(config: MinerConfig, options: ServeOptions = {}): Promise<DaemonHandle> {
  return startDaemon(serveOptions(config, options));
}

export function serveMinerUntilSignal(config: MinerConfig, options: ServeOptions = {}): Promise<void> {
  return runDaemonUntilSignal(serveOptions(config, options));
}

/** MCP over stdio for clients that launch the miner as a subprocess. */
export function runMinerMcpStdio(config: MinerConfig): Promise<void> {
  return runMcpStdio({
    registry: createMinerRegistry(),
    createContext: () => createMinerContext(config),
    toolPrefix: TOOL_PREFIX,
    name: "titan-session-miner",
    version: MINER_VERSION,
  });
}

export { status as statusCommand };

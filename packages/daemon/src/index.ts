export type { Surface, SurfaceOptions } from "./surface.js";
export type { HttpAppOptions } from "./http.js";
export { buildHttpApp } from "./http.js";
export type { HealthPayload, HealthPayloadInput } from "./health.js";
export { buildHealthPayload } from "./health.js";
export type { SseMessage, Subscriber } from "./events.js";
export { EventHub } from "./events.js";
export type { TreeWatcher, WatchTreeOptions } from "./file-watch.js";
export { watchTree } from "./file-watch.js";
export type { DaemonMeta, DaemonPaths, PidFileContents, ProbeHealthOptions } from "./lifecycle.js";
export {
  DEFAULT_DAEMON_PORT,
  daemonPaths,
  getProcessCommand,
  isProcessAlive,
  probeHealth,
  readPidFile,
  removePidFile,
  writePidFile,
} from "./lifecycle.js";
export type { Logger } from "./logger.js";
export { consoleLogger, silentLogger } from "./logger.js";
export type { McpServerOptions, ToolCallOutcome } from "./mcp.js";
export { attachHandlers, createMcpServer, invokeTool, listTools, runMcpStdio } from "./mcp.js";
export type { DaemonHandle, StartDaemonOptions } from "./daemon.js";
export { DaemonAlreadyRunningError, runDaemonUntilSignal, startDaemon } from "./daemon.js";

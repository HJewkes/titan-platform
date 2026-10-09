export type { Surface, SurfaceOptions } from "./surface.js";
export type { EventLimits, HttpAppOptions } from "./http.js";
export { DEFAULT_EVENT_LIMITS, buildHttpApp } from "./http.js";
export type { HealthPayload, HealthPayloadInput } from "./health.js";
export { buildHealthPayload } from "./health.js";
export type { SseMessage, Subscriber } from "./events.js";
export { EventHub } from "./events.js";
export type { GuardRefusal, GuardedRequest, RequestGuard, RequestGuardOptions } from "./guards.js";
export { CLIENT_HEADER, DEFAULT_ALLOWED_HOSTS, createRequestGuard } from "./guards.js";
export type { TreeWatcher, WatchTreeOptions } from "./file-watch.js";
export { watchTree } from "./file-watch.js";
export type { DaemonMeta, DaemonPaths, PidFileContents, ProbeHealthOptions } from "./lifecycle.js";
export {
  DEFAULT_DAEMON_PORT,
  daemonPaths,
  getProcessCommand,
  getProcessStartTime,
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
export { NonLoopbackBindError, RemoteBindError, isLoopbackHost } from "./bind-guard.js";
export type { DaemonAuth, DaemonAuthOptions, LoginCodeLedger, RequestAuth, TokenFileProblem } from "./auth.js";
export {
  LOGIN_CODE_TTL_MS,
  LOGIN_PATH,
  LOGOUT_PATH,
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  TokenFileError,
  consumeLoginCode,
  createDaemonAuth,
  createLoginCodeLedger,
  ensureTokenFile,
  getRequestAuth,
  mintLoginCode,
  rotateTokenFile,
  signSession,
  verifySession,
} from "./auth.js";
export type { DaemonHandle, RemoteListenerOptions, StartDaemonOptions } from "./daemon.js";
export { DaemonAlreadyRunningError, DaemonPortInUseError, runDaemonUntilSignal, startDaemon } from "./daemon.js";
export type { StaticAppOptions } from "./static-app.js";
export { mountStaticApp } from "./static-app.js";

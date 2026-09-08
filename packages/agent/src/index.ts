export type { AgentRunDeps } from "./run.js";
export { DEFAULT_INACTIVITY_MS, runAgent } from "./run.js";
export type {
  AgentFailure,
  AgentFailureKind,
  AgentInit,
  AgentRunConfig,
  AgentRunResult,
  AgentUsage,
} from "./types.js";
export type { ClassifyOptions } from "./failures.js";
export { classifyResult, sumModelCost, usageFromResult } from "./failures.js";
export type { PrepareEnvOptions } from "./env.js";
export {
  ANTI_NESTING_VARS,
  AuthMisconfiguredError,
  CLAUDE_CODE_PASSTHROUGH_VARS,
  DEFAULT_MAX_RETRIES,
  FORBIDDEN_API_KEY_SOURCES,
  STRIPPED_AUTH_VARS,
  STRIPPED_PROXY_VARS,
  assertApiKeySourceAllowed,
  assertAuthEnvOk,
  prepareEnv,
} from "./env.js";

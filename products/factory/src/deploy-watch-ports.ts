import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { buildSha } from "./build-info.js";
import { configPath, factoryStateDir, loadConfig } from "./config.js";
import { deployWatch, type DeployWatch } from "./deploy-watch.js";
import { AGENT_CALL_TIMEOUT_MS, agentChatAgents } from "./shepherd/agents.js";
import { REDEPLOY_LOG } from "./shepherd/redeploy.js";
import { inspectIndexLock, nodeLockProbe } from "./stale-lock.js";

/** Enough for the last few dozen deploys; redeploy.log is never rotated, so it is not read whole. */
const LOG_TAIL_BYTES = 256 * 1024;

function readTail(path: string, maxBytes = LOG_TAIL_BYTES): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Notifies only when both an agent-chat bin and a hub seat are configured. */
function hubNotify(env: NodeJS.ProcessEnv): ((text: string) => Promise<void>) | undefined {
  const { agentChatBin, hubSeat } = loadConfig(configPath(env)).shepherd ?? {};
  if (!agentChatBin || !hubSeat) return undefined;
  const agents = agentChatAgents(agentChatBin, { timeoutMs: AGENT_CALL_TIMEOUT_MS });
  return (text) => agents.message(hubSeat, text);
}

/** The production watch over `checkout`, the service checkout serve runs from, and the deployer's state dir. */
export function configuredDeployWatch(env: NodeJS.ProcessEnv, checkout: string): DeployWatch {
  const sha = buildSha();
  const notify = hubNotify(env);
  const stateDir = factoryStateDir(env);
  return deployWatch({
    readLog: () => readTail(join(stateDir, REDEPLOY_LOG)),
    runningSha: () => sha,
    indexLock: () => inspectIndexLock(checkout, nodeLockProbe),
    ...(notify && { notify }),
    now: Date.now,
  });
}

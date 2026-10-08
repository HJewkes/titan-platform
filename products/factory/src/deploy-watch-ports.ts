import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { execGh, type GhExec } from "@titan-design/github";
import { buildSha, DIRTY_SUFFIX, FACTORY_REPO, UNKNOWN_BUILD_SHA } from "./build-info.js";
import { configPath, factoryStateDir, loadConfig } from "./config.js";
import type { MainLag } from "./deploy-health.js";
import { deployWatch, type DeployWatch } from "./deploy-watch.js";
import { redactForEvidence } from "./redact.js";
import { AGENT_CALL_TIMEOUT_MS, agentChatAgents } from "./shepherd/agents.js";
import { REDEPLOY_LOG } from "./shepherd/redeploy.js";
import { inspectIndexLock, nodeLockProbe } from "./stale-lock.js";

/** Enough for the last few dozen deploys; redeploy.log is never rotated, so it is not read whole. */
const LOG_TAIL_BYTES = 256 * 1024;
const LAG_TIMEOUT_MS = 10_000;

export function readTail(path: string, maxBytes = LOG_TAIL_BYTES): string | undefined {
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

/** compare lists the build's missing commits oldest first, so the first one's commit time is how long main has been ahead. */
export async function mainLag(sha: string, repo: string | undefined = FACTORY_REPO, exec: GhExec = execGh): Promise<MainLag | string> {
  if (sha === UNKNOWN_BUILD_SHA || sha.endsWith(DIRTY_SUFFIX) || repo === undefined) return `no clean build sha to compare (${sha})`;
  const args = ["api", `repos/${repo}/compare/${sha}...main`, "--jq", `"\\(.ahead_by) \\(.commits[0].commit.committer.date // "")"`];
  try {
    const { code, stdout, stderr } = await exec(args, undefined, { timeoutMs: LAG_TIMEOUT_MS });
    if (code !== 0) return redactForEvidence(`gh compare failed (${code}): ${stderr.trim() || stdout.trim()}`);
    const [ahead, date] = stdout.trim().split(" ");
    const behind = Number(ahead);
    if (!Number.isInteger(behind) || behind < 0) return "gh compare returned no commit count";
    const oldestAt = date ? Date.parse(date) : NaN;
    return Number.isNaN(oldestAt) ? { behind } : { behind, oldestAt };
  } catch (error) {
    return redactForEvidence(`gh compare failed: ${error instanceof Error ? error.message : String(error)}`);
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
  return deployWatch({
    readLog: () => readTail(join(factoryStateDir(env), REDEPLOY_LOG)),
    runningSha: () => sha,
    lag: () => mainLag(sha),
    indexLock: () => inspectIndexLock(checkout, nodeLockProbe),
    ...(notify && { notify }),
    now: Date.now,
  });
}

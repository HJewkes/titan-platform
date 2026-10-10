import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OwnerItemDeposit } from "@titan-design/owner-queue";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import { buildSha } from "./build-info.js";
import { configPath, factoryStateDir, loadConfig, type FactoryConfig } from "./config.js";
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

type ShepherdConfig = NonNullable<FactoryConfig["shepherd"]>;

/** Notifies only when both an agent-chat bin and a hub seat are configured. */
function hubNotify({ agentChatBin, hubSeat }: ShepherdConfig): ((text: string) => Promise<void>) | undefined {
  if (!agentChatBin || !hubSeat) return undefined;
  const agents = agentChatAgents(agentChatBin, { timeoutMs: AGENT_CALL_TIMEOUT_MS });
  return (text) => agents.message(hubSeat, text);
}

const expandHome = (value: string, home: string): string => (value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value);

/**
 * The deposit spool the titan console reads: `TITAN_CONSOLE_INBOX_DIR`, else `inbox/deposits` under
 * `TITAN_CONSOLE_STATE` (default `~/.local/state/titan-console`), the resolution agent-chat's burndown tick uses.
 */
function ownerInboxDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  if (env.TITAN_CONSOLE_INBOX_DIR) return expandHome(env.TITAN_CONSOLE_INBOX_DIR, home);
  return join(expandHome(env.TITAN_CONSOLE_STATE ?? "~/.local/state/titan-console", home), "inbox", "deposits");
}

/** The production watch over `checkout`, the service checkout serve runs from, and the deployer's state dir. */
export function configuredDeployWatch(env: NodeJS.ProcessEnv, checkout: string): DeployWatch {
  const sha = buildSha();
  const shepherd = loadConfig(configPath(env)).shepherd ?? {};
  const notify = hubNotify(shepherd);
  const stateDir = factoryStateDir(env);
  const inbox = ownerInboxDir(env);
  return deployWatch({
    readLog: () => readTail(join(stateDir, REDEPLOY_LOG)),
    runningSha: () => sha,
    indexLock: () => inspectIndexLock(checkout, nodeLockProbe),
    ...(notify && { notify }),
    escalate: async (deposit: OwnerItemDeposit) => void (await writeDeposit(inbox, deposit)),
    ...(shepherd.deployAlarm && { policy: shepherd.deployAlarm }),
    now: Date.now,
  });
}

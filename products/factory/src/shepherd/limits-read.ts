import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LimitsBlockMissingError, loadLimits } from "@titan-design/agent-dispatch/limits/node";
import type { SpawnLimits } from "./spawn-limits.js";

const logged = new Set<string>();

/** For tests: forget which fallbacks were already logged. */
export function resetLimitsReadLog(): void {
  logged.clear();
}

function logOnce(message: string): void {
  if (logged.has(message)) return;
  logged.add(message);
  console.error(`shepherd: ${message}; the factory config values stand`);
}

/**
 * The shepherd keys of `limits` in `$AGENT_CHAT_HOME/config.json`, as spawn limits. A missing file or
 * block yields nothing quietly; a malformed one yields nothing and is logged once, so the factory values stand.
 */
export function readShepherdLimits(env: NodeJS.ProcessEnv): Partial<SpawnLimits> {
  const path = join(env.AGENT_CHAT_HOME || join(homedir(), ".agent-chat"), "config.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = loadLimits(path, { key: "limits" });
    if (parsed.ignoredSections.shepherd) logOnce(`limits.shepherd in ${path} is ignored: ${parsed.ignoredSections.shepherd}`);
    const { spawn_gate: gate, review } = parsed.limits.shepherd ?? {};
    const keys = { load5: gate?.load5, buildLoad5: gate?.build_load5, maxConcurrentReviews: review?.max_concurrent };
    return Object.fromEntries(Object.entries(keys).filter(([, value]) => value !== undefined));
  } catch (error) {
    // A file with no limits block is a host that has not set any.
    if (error instanceof LimitsBlockMissingError) return {};
    logOnce(`limits in ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

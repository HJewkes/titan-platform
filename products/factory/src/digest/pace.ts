import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { PoolLine } from "./model.js";

/** The fields of a pool row the Spend section reads; the watchdog writes more, which are ignored. */
const PacePool = z.object({ sevenDay: z.number().optional(), fiveHour: z.number().optional(), stale: z.boolean().default(false) });
const PaceFile = z.object({ pools: z.record(z.string(), PacePool) });

/** agent-chat's seat watchdog writes `pace.json` under AGENT_CHAT_HOME, as agent-chat resolves it. */
export function pacePath(env: NodeJS.ProcessEnv): string {
  return join(env.AGENT_CHAT_HOME || join(homedir(), ".agent-chat"), "pace.json");
}

/** One line per pool in the watchdog's last pass; a missing or malformed file throws, which the digest turns into a gap. */
export function readPacePools(file: string): PoolLine[] {
  const parsed = PaceFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`unexpected pace.json: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return Object.entries(parsed.data.pools).map(([pool, row]) => ({
    pool,
    stale: row.stale,
    ...(row.sevenDay !== undefined && { sevenDay: row.sevenDay }),
    ...(row.fiveHour !== undefined && { fiveHour: row.fiveHour }),
  }));
}

import { existsSync, readFileSync } from "node:fs";
import { EXIT } from "@titan-design/registry";
import { parseBrokerLog, type BrokerEntry } from "@titan-design/session-analytics";

/** Every entry of agent-chat's broker log, read once and never opened for writing. */
export function readBrokerLog(file: string): BrokerEntry[] {
  if (!existsSync(file)) throw Object.assign(new Error(`agent-chat broker log not found: ${file} (set TITAN_MINER_BROKER_LOG or pass --broker-log)`), { code: EXIT.DATAERR });
  return parseBrokerLog(readFileSync(file, "utf8").split("\n"));
}

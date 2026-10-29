import { join } from "node:path";
import { factoryStateDir, type FactoryConfig } from "./config.js";
import { agentChatAgents } from "./shepherd/agents.js";
import type { RosterReader } from "./shepherd/roster.js";
import type { SpawnGate } from "./shepherd/spawn-gate.js";
import { DEFAULT_PACKAGER_PROFILE, type VisualPacketPorts } from "./shepherd/visual-packet-trigger.js";
import { DEFAULT_DIAGNOSIS_PROFILE, readLogTail, type DiagnosisPorts } from "./shepherd/no-verdict-diagnosis.js";

/** The ports of the agents the route wiring spawns on its own, each through the shared roster and spawn gate. */

type CwdFor = (repo: string) => string | undefined;

/** The packager spawns under agent-chat's default account; `off` wires nothing. */
export function configuredVisualPacket(shepherd: FactoryConfig["shepherd"], env: NodeJS.ProcessEnv, roster: RosterReader | undefined, gate: SpawnGate, cwdFor: CwdFor): VisualPacketPorts | undefined {
  const mode = shepherd?.visualPacket ?? "off";
  if (mode === "off") return undefined;
  const agentChatBin = shepherd?.agentChatBin;
  const agents = agentChatBin && { agents: agentChatAgents(agentChatBin, { roster, gate }) };
  const bin = shepherd?.titanReviewBin && { titanReviewBin: shepherd.titanReviewBin };
  return { mode, profile: shepherd?.visualPacketProfile ?? DEFAULT_PACKAGER_PROFILE, stateDir: factoryStateDir(env), cwdFor, ...agents, ...bin };
}

/** The planner spawns at the configured profile as given, and reports to the hub seat. */
export function configuredDiagnosis(shepherd: FactoryConfig["shepherd"], env: NodeJS.ProcessEnv, roster: RosterReader | undefined, gate: SpawnGate, cwdFor: CwdFor): DiagnosisPorts {
  const agentChatBin = shepherd?.agentChatBin;
  const agents = agentChatBin && { agents: agentChatAgents(agentChatBin, { roster, gate }) };
  const hubSeat = shepherd?.hubSeat;
  const errLog = join(factoryStateDir(env), "serve.err.log");
  return { profile: shepherd?.diagnosisProfile ?? DEFAULT_DIAGNOSIS_PROFILE, cwdFor, readLog: () => readLogTail(errLog), reportTo: () => hubSeat, ...agents };
}

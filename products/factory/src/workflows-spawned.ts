import { join } from "node:path";
import { factoryStateDir, type FactoryConfig } from "./config.js";
import { agentChatAgents } from "./shepherd/agents.js";
import { DEFAULT_PACKAGER_PROFILE } from "./shepherd/visual-packet-trigger.js";
import { DEFAULT_DIAGNOSIS_PROFILE, readLogTail } from "./shepherd/no-verdict-diagnosis.js";
import { DEFAULT_REPLAN_PROFILE } from "./shepherd/replan.js";
import type { DiagnosisPorts, ReplanPorts, VisualPacketPorts } from "./shepherd/spawn-ports.js";
import type { RosterReader, SpawnGate } from "./shepherd/ports.js";

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

/** The replan planner spawns at the configured profile as given; its brief names the seat it reports to. */
export function configuredReplan(shepherd: FactoryConfig["shepherd"], roster: RosterReader | undefined, gate: SpawnGate, cwdFor: CwdFor): ReplanPorts {
  const agentChatBin = shepherd?.agentChatBin;
  const agents = agentChatBin && { agents: agentChatAgents(agentChatBin, { roster, gate }) };
  return { profile: shepherd?.replanProfile ?? DEFAULT_REPLAN_PROFILE, cwdFor, ...agents };
}

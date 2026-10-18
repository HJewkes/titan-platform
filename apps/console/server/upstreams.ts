import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { consoleLogger, probeHealth, type Logger } from "@titan-design/daemon";
import { activeWorkClient, type ActiveWork } from "./active-work.js";
import { brokerReader } from "./broker.js";
import { brokerAnswerer } from "./broker-answer.js";
import type { ConsoleSources } from "./commands.js";
import type { ConsoleConfig } from "./config.js";
import { createDecisionLog, type HumanOnly } from "./decision-log.js";
import { factoryNeeds } from "./factory.js";
import { factoryGateAnswer } from "./gate-answer.js";
import { createRoundListeners } from "./listeners.js";
import { factoryOwnerAction } from "./owner-action.js";
import { shepherdReader } from "./shepherd.js";

/** Under the state dir; the factory's `consoleAnswers.actionsDir` must name the same directory. */
const OWNER_ACTIONS_DIR = "owner-actions";

export const UPSTREAM_IDS = ["work", "agents", "sessions"] as const;
export type UpstreamId = (typeof UPSTREAM_IDS)[number];

export interface ProbeResult {
  reachable: boolean;
  detail: string;
}

/** One source the console fronts; the id is the namespace its commands will live under. */
export interface Upstream {
  id: UpstreamId;
  label: string;
  /** A loopback origin or a file path, for display. */
  target: string;
  /** Never throws and never starts the upstream. */
  probe(): Promise<ProbeResult>;
}

export interface UpstreamHealth extends ProbeResult {
  id: UpstreamId;
  label: string;
  target: string;
}

const PROBE_TIMEOUT_MS = 1000;

type HealthPayload = Record<string, unknown>;

/** Active-work reports an `index` object; the agent-chat broker reports its `socket` path. Neither carries a name. */
const IDENTITIES: Partial<Record<UpstreamId, (payload: HealthPayload) => boolean>> = {
  work: (payload) => typeof payload.index === "object" && payload.index !== null,
  agents: (payload) => typeof payload.socket === "string",
};

/** probeHealth returns whatever JSON the port sent, so a scalar or array body reaches the identity checks unless refused here. */
function isHealthObject(payload: unknown): payload is HealthPayload {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

/** Session-miner reports `ftsOrphanRatio`, or `indexError` when its graph cannot be read. */
function describeAnswerer(payload: HealthPayload): string {
  const isMiner = "ftsOrphanRatio" in payload || "indexError" in payload;
  const name = isMiner ? "titan-miner" : "an unrecognised daemon";
  return typeof payload.version === "string" ? `${name} ${payload.version}` : name;
}

/** A daemon on loopback that answers `GET /health` with the identity its upstream expects. */
export function httpUpstream(id: UpstreamId, label: string, port: number): Upstream {
  const probe = async (): Promise<ProbeResult> => {
    const payload: unknown = await probeHealth(port, { timeoutMs: PROBE_TIMEOUT_MS });
    if (!payload) return { reachable: false, detail: "No answer from /health" };
    if (!isHealthObject(payload)) return { reachable: false, detail: `Port ${port} answers, but /health is not a JSON object` };
    if (IDENTITIES[id]?.(payload) === false) return { reachable: false, detail: `Port ${port} answers, but not as the ${label} (${describeAnswerer(payload)})` };
    return { reachable: true, detail: typeof payload.version === "string" ? `Version ${payload.version}` : "Answering" };
  };
  return { id, label, target: `http://127.0.0.1:${port}`, probe };
}

/** A file another product owns. Only stat is used, so a large database costs nothing to check. */
export function fileUpstream(id: UpstreamId, label: string, file: string, home: string = os.homedir()): Upstream {
  const probe = async (): Promise<ProbeResult> => {
    const info = await stat(file).catch(() => null);
    if (!info) return { reachable: false, detail: "File not found" };
    if (!info.isFile()) return { reachable: false, detail: "Not a file" };
    return { reachable: true, detail: `${formatBytes(info.size)} on disk, not opened` };
  };
  return { id, label, target: file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file, probe };
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  const rung = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(bytes, 1)) / 10));
  return `${(bytes / 1024 ** rung).toFixed(rung === 0 ? 0 : 1)} ${units[rung]}`;
}

export function createUpstreams(config: ConsoleConfig): Upstream[] {
  return [
    httpUpstream("work", "active-work daemon", config.activeWorkPort),
    httpUpstream("agents", "agent-chat broker", config.agentChatPort),
    fileUpstream("sessions", "session graph", config.sessionGraphPath),
  ];
}

export async function probeUpstreams(upstreams: readonly Upstream[]): Promise<UpstreamHealth[]> {
  return Promise.all(upstreams.map(async ({ id, label, target, probe }) => ({ id, label, target, ...(await probe()) })));
}

/** Active-work owns the charter read; an unreadable charter or a down daemon reads as unknown, which excludes every answer. */
export function humanOnlyFrom(activeWork: ActiveWork): () => Promise<HumanOnly> {
  return async () => {
    const inventory = await activeWork.read("inventory").catch(() => null);
    if (inventory === null || !inventory.human_only_known) return { known: false };
    return { known: true, initiatives: new Set(inventory.initiatives.filter((entry) => entry.human_only).map((entry) => entry.slug)) };
  };
}

function inboxActionsOf(config: ConsoleConfig): NonNullable<ConsoleSources["inboxActions"]> {
  return {
    enabled: config.inboxActions ?? false,
    actionsDir: path.join(config.stateDir, OWNER_ACTIONS_DIR),
    client: factoryOwnerAction(config.factoryPort),
    answerer: brokerAnswerer({ port: config.agentChatPort, tokenPath: config.agentChatTokenPath }),
  };
}

export function createSources(config: ConsoleConfig, logger: Logger = consoleLogger): ConsoleSources {
  const activeWork = activeWorkClient(config.activeWorkPort);
  const shepherd = shepherdReader(config.factoryPort);
  return {
    upstreams: createUpstreams(config),
    activeWork,
    agents: {
      broker: brokerReader({ port: config.agentChatPort, tokenPath: config.agentChatTokenPath }),
      eventsDbPath: config.agentChatEventsDbPath,
      seatPrefixes: config.seatPrefixes,
    },
    sessions: { graphPath: config.sessionGraphPath, codewatchUrl: config.codewatchUrl },
    inbox: { dir: config.inboxDir },
    rounds: { dir: config.roundsDir },
    shepherd,
    factory: factoryNeeds(config.factoryPort),
    hostSurfaces: config.hostSurfaces,
    hostReports: { dir: path.join(config.stateDir, "config", "host-reports") },
    decisionLog: createDecisionLog({ stateDir: config.stateDir, decisionsFile: config.decisionsFile, humanOnly: humanOnlyFrom(activeWork), logger }),
    listeners: createRoundListeners({
      enabled: config.gateAnswers,
      roundsDir: config.roundsDir,
      shepherd,
      answer: factoryGateAnswer(config.factoryPort),
      logger,
    }),
    ...(config.configStore ? { configStore: { stateDir: config.stateDir, ...config.configStore } } : {}),
    inboxActions: inboxActionsOf(config),
  };
}

import { askHuman, dismissAsk, readAnswers } from "@titan-design/agent-dispatch";
import type { Logger } from "@titan-design/daemon";
import { configPath, loadConfig } from "./config.js";
import { askable, notifyTick, type GateNotifyPorts } from "./gate-notify.js";
import type { FactoryHost } from "./host.js";
import { AGENT_CALL_TIMEOUT_MS } from "./shepherd/agents.js";
import { startSweep, type Sweep } from "./sweep.js";

const GATE_NOTIFY_MS = 30_000;

/** The agent-chat side of the gate notifier; serve supplies the gates and the `gate_ask` store from its own host. */
export type GateNotifyOptions = Pick<GateNotifyPorts, "label" | "resolverClass" | "askHuman" | "readAnswers" | "dismissAsk">;

/** What health shows, so a gate the phone cannot settle, or a label whose answers cannot be read, is seen rather than waited on. */
interface GateNotifyStatus {
  label: string;
  resolverClass: GateNotifyOptions["resolverClass"];
  /** Asks waiting on an answer. */
  open: number;
  /** Pending gates whose ask ended without resolving them (refused, dismissed, unmappable): they need the terminal now. */
  stuck: { gateId: string; state: string; detail?: string }[];
  /** Pending gates never asked, because the rule does not admit the class or the schema needs a field an answer cannot give. */
  unasked: string[];
  /** The last answers read failure, cleared by the next read that succeeds. */
  answersError?: string;
}

export interface GateNotifyWatch {
  status(): GateNotifyStatus;
  start(): Sweep;
}

/** Reads `shepherd.gateNotify`; absent, the factory asks nothing, which is the default. */
export function configuredGateNotify(env: NodeJS.ProcessEnv): GateNotifyOptions | undefined {
  const { agentChatBin, gateNotify } = loadConfig(configPath(env)).shepherd ?? {};
  if (!agentChatBin || !gateNotify) return undefined;
  return {
    ...gateNotify,
    askHuman: (req) => askHuman(agentChatBin, req, AGENT_CALL_TIMEOUT_MS),
    readAnswers: (label, since) => readAnswers(agentChatBin, label, since, AGENT_CALL_TIMEOUT_MS),
    dismissAsk: (msgId) => dismissAsk(agentChatBin, msgId, AGENT_CALL_TIMEOUT_MS),
  };
}

export function gateNotifyWatch(host: FactoryHost, options: GateNotifyOptions, log: Logger, everyMs = GATE_NOTIFY_MS): GateNotifyWatch {
  let answersError: string | undefined;
  const readAnswersNoted: GateNotifyOptions["readAnswers"] = async (label, since) => {
    try {
      const page = await options.readAnswers(label, since);
      answersError = undefined;
      return page;
    } catch (error) {
      answersError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
  const ports: GateNotifyPorts = {
    ...options,
    readAnswers: readAnswersNoted,
    pendingGates: () => host.gates.listPending(),
    getGate: (gateId) => host.gates.get(gateId),
    resolve: (gateId, payload, resolver) => void host.gates.resolve(gateId, payload, resolver),
    asks: host.asks,
    log: (line) => log.warn({ label: options.label }, line),
  };
  return {
    status: () => ({ ...notifyStatus(host, options), ...(answersError !== undefined && { answersError }) }),
    start: () => {
      const sweep = startSweep(() => notifyTick(ports), everyMs, "gate notify", log);
      void sweep.tick();
      return sweep;
    },
  };
}

function notifyStatus(host: FactoryHost, { label, resolverClass }: GateNotifyOptions): GateNotifyStatus {
  const stuck: GateNotifyStatus["stuck"] = [];
  const unasked: string[] = [];
  for (const gate of host.gates.listPending()) {
    const ask = host.asks.get(gate.id);
    if (ask === undefined && !askable(gate, resolverClass)) unasked.push(gate.id);
    else if (ask !== undefined && ask.state !== "asked") stuck.push({ gateId: gate.id, state: ask.state, ...(ask.detail !== undefined && { detail: ask.detail }) });
  }
  return { label, resolverClass, open: host.asks.open().length, stuck, unasked };
}

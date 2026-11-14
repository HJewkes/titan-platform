import type { GateQuestion } from "@titan-design/hitl";
import type { QueueSource } from "@titan-design/owner-queue";
import type { BaseContext } from "@titan-design/registry";
import type { ArConfig } from "./autoresearch/config.js";
import type { Caller } from "./caller.js";
import type { FactoryHost } from "./host.js";
import type { AgentAllowList } from "./needs/agent-allow-list.js";
import type { ShepherdServices } from "./shepherd/services.js";

/** The owner-queue adapters a needs read merges; `personal` asks the active-work source for charter-personal initiatives too. */
export type NeedsSources = (options: { personal: boolean }) => readonly QueueSource[] | Promise<readonly QueueSource[]>;

export interface FactoryContext extends BaseContext {
  host: FactoryHost;
  /** Resolved once at the surface or shell; needs reads filter on it. */
  caller: Caller;
  /** Absent when the host runs routes without the shepherd store; the shepherd commands then refuse. */
  shepherd?: ShepherdServices;
  /** The serving factory's name, which an owner proof must carry as its `aud`; defaults to this machine's hostname. */
  aud?: string;
  /** Replaces the live owner-queue adapters behind needs.list and needs.count; tests inject it. */
  needsSources?: NeedsSources;
  /** Replaces the live inventory read that decides which initiatives an agent caller sees; tests inject it. */
  needsAllowed?: AgentAllowList;
  /** The local clone of an autoresearch target, from factory config; `autoresearch.diff` refuses a target with none. */
  autoresearchClone?: (target: string) => string | undefined;
  /** The autoresearch config section; absent, the autoresearch write commands refuse `[no-config]`. */
  autoresearch?: ArConfig;
}

export interface GateSummary {
  runId: string;
  stepId: string;
  gateId: string;
  prompt: string;
  schema: unknown;
  resolve: string;
  /** Absent on a gate opened before the brief migration; surfaces fall back to `prompt`. */
  summary?: string;
  evidenceRef?: string;
  questions?: GateQuestion[];
  createdAt: string;
}

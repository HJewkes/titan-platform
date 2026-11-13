import type { GateQuestion } from "@titan-design/hitl";
import type { QueueSource } from "@titan-design/owner-queue";
import type { BaseContext } from "@titan-design/registry";
import type { ArConfig } from "./autoresearch/config.js";
import type { FactoryHost } from "./host.js";
import type { ShepherdServices } from "./shepherd/services.js";

/** The owner-queue adapters a needs read merges; `personal` asks the active-work source for charter-personal initiatives too. */
export type NeedsSources = (options: { personal: boolean }) => readonly QueueSource[] | Promise<readonly QueueSource[]>;

export interface FactoryContext extends BaseContext {
  host: FactoryHost;
  /** Set by the surface: serve's HTTP (the console) is the owner, MCP an agent. Unset reads as restricted (TP-5556). */
  caller?: "owner" | "agent";
  /** Absent when the host runs routes without the shepherd store; the shepherd commands then refuse. */
  shepherd?: ShepherdServices;
  /** The serving factory's name, which an owner proof must carry as its `aud`; defaults to this machine's hostname. */
  aud?: string;
  /** Replaces the live owner-queue adapters behind needs.list and needs.count; tests inject it. */
  needsSources?: NeedsSources;
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

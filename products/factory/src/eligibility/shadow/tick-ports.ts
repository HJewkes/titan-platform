import type { Task } from "@titan-design/pm";
import { activeWorkRoot } from "@titan-design/app-paths";
import type { Verbs } from "../../cli-types.js";
import { inventoryAllowList, type AgentAllowList } from "../../needs/agent-allow-list.js";
import { activeWorkOrigin } from "../../shepherd/cleanup-ports.js";
import type { SelectionPolicy } from "../intake.js";
import { citedPrs, liveStoppedPrs, type StoppedPrRead } from "../intake-signals.js";
import type { RuleFile } from "./rule-file.js";

/** The tick's outside reads beyond active-work's rpc, each replaceable in a test. */
export interface TickPorts {
  /** active-work's data root: the plan store the plan-read fallback reads. */
  activeRoot: string;
  stoppedPrs: StoppedPrRead;
  /** The initiatives active-work does not withhold from agents (TP-5556): its verdict, never one built here. */
  agentLanes: AgentAllowList;
}

export function tickPorts(verbs: Verbs, given: Partial<TickPorts> = {}): TickPorts {
  const activeRoot = given.activeRoot ?? activeWorkRoot({ env: verbs.io.env });
  const agentLanes = given.agentLanes ?? inventoryAllowList(activeWorkOrigin(verbs.io.env), verbs.deps.fetch);
  return { activeRoot, stoppedPrs: given.stoppedPrs ?? liveStoppedPrs(verbs), agentLanes };
}

/** The rule file's policy for one lane read; an unread Shepherd leaves `stoppedPrs` unread, which refuses each task citing a PR. */
export function policyFor(rules: RuleFile, today: string, stoppedPrs: StoppedPrRead): (tasks: readonly Task[]) => Promise<SelectionPolicy> {
  return async (tasks) => {
    let stopped: SelectionPolicy["stoppedPrs"];
    try {
      stopped = await stoppedPrs(citedPrs(tasks));
    } catch {
      stopped = "unread";
    }
    return { relax: rules.relax, intake: rules.intake, today, stoppedPrs: stopped };
  };
}

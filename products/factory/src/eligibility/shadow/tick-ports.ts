import type { Task } from "@titan-design/pm";
import { activeWorkRoot } from "@titan-design/app-paths";
import type { Verbs } from "../../cli-types.js";
import { activeWorkOrigin } from "../../shepherd/cleanup-ports.js";
import type { SelectionPolicy } from "../intake.js";
import { citedPrs, liveStoppedPrs, type StoppedPrRead } from "../intake-signals.js";
import { shadowAgentLanes, type AgentLanesRead } from "./agent-lanes.js";
import type { RuleFile } from "./rule-file.js";

/** The tick's outside reads beyond active-work's rpc, each replaceable in a test. */
export interface TickPorts {
  /** active-work's data root: the plan store the plan-read fallback reads. */
  activeRoot: string;
  stoppedPrs: StoppedPrRead;
  /** The initiatives active-work does not withhold from agents (TP-5556); rebuilt from its files only for an older daemon (TP-5868). */
  agentLanes: AgentLanesRead;
}

export function tickPorts(verbs: Verbs, given: Partial<TickPorts> = {}): TickPorts {
  const activeRoot = given.activeRoot ?? activeWorkRoot({ env: verbs.io.env });
  const agentLanes = given.agentLanes ?? shadowAgentLanes(activeWorkOrigin(verbs.io.env), activeRoot, verbs.deps.fetch);
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

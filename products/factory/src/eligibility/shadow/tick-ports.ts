import type { Task } from "@titan-design/pm";
import { activeWorkRoot } from "@titan-design/app-paths";
import type { Verbs } from "../../cli-types.js";
import type { SelectionPolicy } from "../intake.js";
import { citedPrs, liveStoppedPrs, type StoppedPrRead } from "../intake-signals.js";
import type { RuleFile } from "./rule-file.js";
import { liveLaneAccess, type LaneAccessRead } from "./visibility.js";

/** The tick's outside reads beyond active-work's rpc, each replaceable in a test. */
export interface TickPorts {
  /** active-work's data root: the plan store the plan-read fallback reads, and the briefs and charter visibility reads. */
  activeRoot: string;
  stoppedPrs: StoppedPrRead;
  access: LaneAccessRead;
}

export function tickPorts(verbs: Verbs, given: Partial<TickPorts> = {}): TickPorts {
  const activeRoot = given.activeRoot ?? activeWorkRoot({ env: verbs.io.env });
  return { activeRoot, stoppedPrs: given.stoppedPrs ?? liveStoppedPrs(verbs), access: given.access ?? liveLaneAccess(activeRoot) };
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

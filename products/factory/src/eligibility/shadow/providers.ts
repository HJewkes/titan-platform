import type { Verbs } from "../../cli-types.js";
import type { BackPressureLimits, LaneSignals } from "../back-pressure.js";
import { landedHolds } from "../landed-signals.js";
import type { Eligibility } from "../rules.js";
import { stopHolds } from "../stop-signals.js";
import { upkeepCapHolds } from "../upkeep-signals.js";
import type { RuleFile, ShadowLane } from "./rule-file.js";
import type { RefusedRow, Stage } from "./row.js";

interface ProviderContext {
  lane: ShadowLane;
  week: string;
  rules: RuleFile;
  /** The lane's eligible tasks in dispatch order, before any hold. */
  eligible: Eligibility["eligible"];
  verbs: Verbs;
  /** The wake's instant in ms, and the lane's own signals and limits, so a rule never reads them twice. */
  now: number;
  signals: LaneSignals;
  limits: BackPressureLimits;
}

export interface TaskHold {
  /** The task's `initiative/ID` key. */
  task: string;
  stage: Exclude<Stage, "eligibility">;
  codes: string[];
  details?: string[];
  numbers?: Record<string, number>;
  next?: RefusedRow["next"];
  would_ask?: true;
}

export type HoldProvider = (ctx: ProviderContext) => Promise<{ holds: TaskHold[] }>;

/** Run in order after the lane's admission; each later slice appends one entry here and touches nothing else. */
export const HOLD_PROVIDERS: readonly HoldProvider[] = [upkeepCapHolds, stopHolds, landedHolds];

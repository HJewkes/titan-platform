import type { Task } from "@titan-design/pm";
import type { WorkflowRun } from "@titan-design/workflow";
import type { Verbs } from "../cli-types.js";
import { EXIT } from "../exit-codes.js";
import { activeWorkOrigin } from "../shepherd/cleanup-ports.js";
import { ShepherdStore } from "../shepherd/store.js";
import { watchRow } from "../shepherd/view.js";
import { readLaneTasks } from "./active-work.js";
import type { BackPressureLimits, LaneSignals } from "./back-pressure.js";
import { landedRuleHolds, type LandedHold, type LandedTask } from "./landed.js";

/*
 * What the landed rules read (TP-5755 S5): the lane's tasks from active-work and the tasks whose Shepherd run merged,
 * from the factory's own store. Read-only, like every shadow signal.
 */

export interface LandedFacts {
  laneTasks: readonly LandedTask[];
  mergedTasks: ReadonlySet<string>;
}

interface LandedContext {
  lane: { initiative: string; tag: string | null };
  eligible: readonly { task: Task }[];
  verbs: Verbs;
  now: number;
  signals: LaneSignals;
  limits: BackPressureLimits;
}

export type LandedRead = (query: {
  lane: LandedContext["lane"];
  verbs: Verbs;
}) => Promise<LandedFacts>;

async function mergedTaskKeys(
  verbs: Verbs,
  inLane: ReadonlySet<string>
): Promise<Set<string>> {
  const merged = new Set<string>();
  await verbs.withHost((host) => {
    const hasTable =
      host.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shepherd_registration'"
        )
        .get() !== undefined;
    if (!hasTable) return EXIT.OK;
    for (const registration of new ShepherdStore(host.db).all()) {
      if (!inLane.has(registration.task)) continue;
      const run: WorkflowRun | undefined = host.runtime.status(
        registration.runId
      );
      if (run && watchRow({ registration, run }).outcome?.kind === "merged")
        merged.add(registration.task);
    }
    return EXIT.OK;
  });
  return merged;
}

export const liveLandedFacts: LandedRead = async ({ lane, verbs }) => {
  const source = {
    origin: activeWorkOrigin(verbs.io.env),
    ...(verbs.deps.fetch && { fetch: verbs.deps.fetch }),
  };
  const { keys, tasks } = await readLaneTasks(source, {
    initiative: lane.initiative,
    ...(lane.tag !== null && { tag: lane.tag }),
  });
  return { laneTasks: tasks, mergedTasks: await mergedTaskKeys(verbs, keys) };
};

/** The landed rules as a hold provider over `read`; a lane with no candidate reads nothing. */
export function landedProvider(
  read: LandedRead
): (ctx: LandedContext) => Promise<{ holds: LandedHold[] }> {
  return async function landedHolds(ctx) {
    if (ctx.eligible.length === 0) return { holds: [] };
    const facts = await read({ lane: ctx.lane, verbs: ctx.verbs });
    return {
      holds: landedRuleHolds({
        initiative: ctx.lane.initiative,
        eligible: ctx.eligible,
        ...facts,
        signals: ctx.signals,
        limits: ctx.limits,
        now: ctx.now,
      }),
    };
  };
}

export const landedHolds = landedProvider(liveLandedFacts);

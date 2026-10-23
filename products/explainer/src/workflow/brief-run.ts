import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prDiag } from "../presets/pr-overview/diagnostics.js";
import { writeGather } from "../presets/pr-overview/gather.js";
import { DECISION_BRIEF_CUT, writeBrief, type StartBrief } from "../presets/pr-overview/trigger.js";
import { runVideo, type RunHost } from "./host.js";
import type { StageName } from "./records.js";

/** A decision brief runs its gather stage, then the storyboard-only audition; the script waits on a spine. */
const BRIEF_LAST_STAGE: StageName = "audition";

/**
 * The trigger's production start: writes `brief.json`, then runs the decision-brief video from its gather stage. The
 * gather writes `facts.jsonl` and `gather.json` into the brief's directory, and `run.json` names the run it made.
 */
export function briefRunStart(host: RunHost, cloneFor: (repo: string) => string | undefined): StartBrief {
  return async (target, dir) => {
    await writeBrief(dir, target);
    const clone = cloneFor(target.repo);
    if (clone === undefined) {
      await writeGather(dir, { ok: false, diagnostics: [prDiag("E-NO-CLONE", `no clone is configured for ${target.repo}`)] });
      return "refused";
    }
    const gather = { adapter: "gatherPr" as const, type: "pr-overview", pr: `${target.repo}#${target.number}`, head: target.head, clone };
    const result = await runVideo({ from: "gather", to: BRIEF_LAST_STAGE, gather }, host);
    const stages = result.report.rows.map(({ stage, status }) => ({ stage, status }));
    const run = { runId: result.runId, status: result.status, cut: DECISION_BRIEF_CUT, stages, ...(result.error ? { error: result.error } : {}) };
    await writeFile(join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
    return result.status === "completed" ? "started" : "refused";
  };
}

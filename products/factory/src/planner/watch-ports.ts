import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { PlannerConfig } from "./config.js";
import type { PlannerRun } from "./inputs.js";
import type { PlannerPresence, ReviewFile, WatchPorts } from "./watch.js";

const RosterRow = z.object({ name: z.string(), presence: z.string(), transcriptPath: z.string().nullish() }).loose();
/** `exiting` is still closing, so it may yet write; only a row that is done or absent counts as gone. */
const GONE = new Set(["exited", "deregistered"]);

/** The review dir's files, without the brief when it sits there too; a missing dir reads as empty. */
export function reviewLister(config: PlannerConfig): () => ReviewFile[] {
  const brief = resolve(config.brief);
  return () => {
    let names: string[];
    try {
      names = readdirSync(config.reviewDir);
    } catch {
      return [];
    }
    const paths = names.map((name) => ({ name, path: join(config.reviewDir, name) })).filter(({ path }) => resolve(path) !== brief);
    return paths.flatMap(({ name, path }) => {
      const stats = statSync(path, { throwIfNoEntry: false });
      return stats?.isFile() ? [{ name, mtimeMs: stats.mtimeMs }] : [];
    });
  };
}

/** The planner's row on `agent ls --json`: no row is a planner that has gone, an unreadable roster says nothing. */
export function plannerPresence(config: PlannerConfig, run: PlannerRun): () => Promise<PlannerPresence> {
  return async () => {
    const listed = await run(config.agentChat, ["agent", "ls", "--json"]);
    if (listed.code !== 0) return { state: "unknown" };
    let rows: z.infer<typeof RosterRow>[];
    try {
      rows = z.array(RosterRow).parse(JSON.parse(listed.stdout));
    } catch {
      return { state: "unknown" };
    }
    const row = rows.find((each) => each.name === config.name);
    if (!row) return { state: "gone" };
    return { state: GONE.has(row.presence) ? "gone" : "running", ...(row.transcriptPath && { transcriptPath: row.transcriptPath }) };
  };
}

export function readTranscript(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function watchPorts(config: PlannerConfig, run: PlannerRun, clock: Pick<WatchPorts, "sleep" | "now">): WatchPorts {
  return { listReviews: reviewLister(config), presence: plannerPresence(config, run), readTranscript, ...clock };
}

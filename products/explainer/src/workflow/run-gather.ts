import path from "node:path";
import { execGh, type GhExec } from "@titan-design/github";
import { claudeTranscriptRoots } from "@titan-design/session-read";
import { activeWorkTasks } from "../presets/daily/active-work-tasks.js";
import { gatherDaily, writeDailyGather } from "../presets/daily/gather-daily.js";
import type { SnapshotTask } from "../presets/daily/task-snapshot.js";
import { loadProfiles, profileFor } from "../profile-load.js";

/** The facts adapters `explainer run --facts-from` can run; a type profile names the ones it takes in `inputs.adapters`. */
export const FACT_ADAPTERS = ["gatherDaily"] as const;
export type FactAdapter = (typeof FACT_ADAPTERS)[number];

/** The adapter's outside world, injectable so a test runs on a fake gh, fixture transcripts and a frozen task list. */
export interface GatherDeps {
  gh?: GhExec;
  listTasks?: (initiative: string) => Promise<SnapshotTask[]>;
}

export interface GatherFlags {
  factsFrom: FactAdapter;
  type?: string;
  day?: string;
  repo: string[];
  transcripts: string[];
  initiative: string;
}

export interface Gathered {
  type: string;
  day: string;
  facts: string;
  digest: string;
  items: number;
  notes: string[];
}

function checkAdapter(flags: GatherFlags): string {
  if (!flags.type) throw new Error(`--facts-from ${flags.factsFrom} needs --type, the video type whose facts it gathers`);
  const profile = profileFor(loadProfiles(), flags.type);
  if (!profile.inputs.adapters.includes(flags.factsFrom)) {
    throw new Error(`type ${flags.type} takes facts from ${profile.inputs.adapters.join(", ") || "no adapter"}, not ${flags.factsFrom}`);
  }
  return flags.type;
}

/** Runs the type's facts adapter into `<dataDir>/gather/<type>/<day>/` and returns the `facts.md` the script stage reads. */
export async function gatherRunFacts(flags: GatherFlags, dataDir: string, deps: GatherDeps = {}): Promise<Gathered> {
  const type = checkAdapter(flags);
  const day = flags.day ?? new Date().toISOString().slice(0, 10);
  const transcriptRoots = flags.transcripts.length > 0 ? flags.transcripts : claudeTranscriptRoots().map((root) => root.root);
  const { digest, notes } = await gatherDaily({
    day, repos: flags.repo, transcriptRoots, initiative: flags.initiative,
    snapshotDir: path.join(dataDir, "task-snapshots"), gh: deps.gh ?? execGh, listTasks: deps.listTasks ?? activeWorkTasks,
  });
  const files = await writeDailyGather(path.join(dataDir, "gather", type, day), digest);
  return { type, day, ...files, items: digest.items.length, notes };
}

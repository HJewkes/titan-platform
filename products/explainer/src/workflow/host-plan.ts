import { readFileSync } from "node:fs";
import { type WorkflowRunStore, type WorkflowRun } from "@titan-design/workflow";
import { loadProfiles, profileFor } from "../profile-load.js";
import type { ArtifactStore } from "./artifacts.js";
import type { RunRequest } from "./host.js";
import { VIDEO_WORKFLOW } from "./pipeline.js";
import { OPTIONAL_STAGES, RUN_INPUTS, STAGES, type StageName, type StageRecord } from "./records.js";
import { stageRecords } from "./report.js";
import { planOf } from "./video-runs.js";



function latestRun(store: WorkflowRunStore): WorkflowRun | undefined {
  const runs = store.listByStatus(["completed", "failed", "cancelled"]).filter((run) => run.workflowName === VIDEO_WORKFLOW);
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

export function inputArtifacts(request: Pick<RunRequest, "spine" | "facts">, store: ArtifactStore): Record<string, string> {
  const files: Record<(typeof RUN_INPUTS)[number], string | undefined> = { spine: request.spine, facts: request.facts };
  const given = Object.entries(files).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return Object.fromEntries(given.map(([name, file]) => [name, store.putText(readFileSync(file, "utf8"), name, { runId: "input", stage: "input" })]));
}

export function reusedFromBase(base: WorkflowRun, from: StageName): { reused: StageRecord[]; artifacts: Record<string, string> } {
  const records = stageRecords(base);
  const before = STAGES.slice(0, STAGES.indexOf(from));
  const reused = before.map((stage) => {
    const found = records.find((record) => record.stage === stage);
    if (!found && OPTIONAL_STAGES.includes(stage)) return undefined;
    if (!found) throw new Error(`base run ${base.id} has no completed ${stage} stage; start from ${stage} or earlier`);
    return found;
  }).filter((record) => record !== undefined);
  // A record the base itself reused already has its outputs in the base plan, under any pin; folding it again would undo the pin.
  const ran = reused.filter((record) => !record.reusedFrom);
  const artifacts = ran.reduce<Record<string, string>>((acc, record) => ({ ...acc, ...record.outputs }), { ...planOf(base).artifacts });
  return { reused, artifacts };
}

export function checkPins(pins: Record<string, string>, store: ArtifactStore): Record<string, string> {
  for (const sha of Object.values(pins)) store.path(sha);
  return pins;
}

/** A run from `audition` or `script` starts from its input files; a later start needs a base run or pins. */
export const startsFresh = (from: StageName): boolean => STAGES.indexOf(from) <= STAGES.indexOf("script");

/** True when the profile's audition writes the spine, so a run through the audition needs none given. */
const auditionWritesSpine = (profile: string | undefined): boolean =>
  profile !== undefined && profileFor(loadProfiles(), profile).spine?.from === "audition-pick";

/** The input files a run reads: facts for the audition, spine and facts once it reaches the script. */
export function neededInputs(from: StageName, to: StageName, profile: string | undefined): string[] {
  const reachesScript = startsFresh(from) && STAGES.indexOf(to) >= STAGES.indexOf("script");
  const needed = new Set([...(from === "audition" ? ["facts"] : []), ...(reachesScript ? RUN_INPUTS : [])]);
  // A run from gather makes its own facts.
  if (from === "gather") needed.delete("facts");
  if (STAGES.indexOf(from) <= STAGES.indexOf("audition") && auditionWritesSpine(profile)) needed.delete("spine");
  return [...needed];
}

export function findBase(runs: WorkflowRunStore, id: string | undefined, from: StageName): WorkflowRun {
  const base = id ? runs.get(id) : latestRun(runs);
  if (base?.workflowName === VIDEO_WORKFLOW) return base;
  throw new Error(id ? `no ${VIDEO_WORKFLOW} run ${id}` : `no earlier ${VIDEO_WORKFLOW} run to start --from ${from} on; pass --base`);
}

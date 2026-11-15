import { WorkflowRunStore, type WorkflowRun } from "@titan-design/workflow";
import { openState, type RunHost } from "./host.js";
import { STAGES, StageRecordSchema, type StageName, type StageRecord } from "./records.js";
import { stageRecords } from "./report.js";
import { readJson, runPaths } from "./run-dir.js";
import { runsOfVideo } from "./video-runs.js";
import { VIDEO_WORKFLOW } from "./pipeline.js";

export interface VideoStageRow {
  stage: StageName;
  status: "ran" | "cached" | "reused" | "failed";
  usd: number;
  wallMs: number;
  costUnknown: boolean;
  outputs: Record<string, string>;
}

export interface VideoRunRow {
  runId: string;
  status: string;
  startedAt: string;
  /** What the run spent itself: a reused or cached stage counts zero. */
  usd: number;
  /** Wall time inside the run's own stages. */
  wallMs: number;
  costUnknown: boolean;
  stages: VideoStageRow[];
}

export interface StageSum {
  stage: StageName;
  usd: number;
  wallMs: number;
  costUnknown: boolean;
}

/** One step of one stage's child workflow, summed over every run that ran it. */
export interface StepSum {
  stage: StageName;
  stepId: string;
  agentIds: string[];
  usd: number;
  calls: number;
  costUnknown: boolean;
}

export interface VideoReport {
  schema: "explainer-video-report/v1";
  videoId: string;
  runs: VideoRunRow[];
  totals: { usd: number; wallMs: number; costUnknown: boolean };
  byStage: StageSum[];
  byStep: StepSum[];
}

type Status = VideoStageRow["status"];

interface Held {
  record: StageRecord;
  status: Status;
}

/** Every record a run holds, a failed stage's included, in stage order. */
function heldBy(dataDir: string, run: WorkflowRun): Held[] {
  const failed = STAGES.map((stage) => readJson(runPaths(dataDir, run.id).failed(stage), StageRecordSchema)).filter((r) => r !== undefined);
  const statusOf = (record: StageRecord): Status => (record.reusedFrom ? "reused" : record.cached ? "cached" : "ran");
  const held: Held[] = [...stageRecords(run).map((record) => ({ record, status: statusOf(record) })), ...failed.map((record) => ({ record, status: "failed" as const }))];
  return held.sort((a, b) => STAGES.indexOf(a.record.stage) - STAGES.indexOf(b.record.stage));
}

const stageRow = ({ record, status }: Held): VideoStageRow => ({
  stage: record.stage, status, usd: record.usage.usd, wallMs: record.wallMs, costUnknown: record.usage.costUnknown === true, outputs: record.outputs,
});

function runRow(run: WorkflowRun, held: readonly Held[]): VideoRunRow {
  const stages = held.map(stageRow);
  return {
    runId: run.id, status: run.status, startedAt: run.startedAt, usd: stages.reduce((sum, s) => sum + s.usd, 0),
    wallMs: stages.reduce((sum, s) => sum + s.wallMs, 0), costUnknown: stages.some((s) => s.costUnknown), stages,
  };
}

function sumByStage(rows: readonly VideoRunRow[]): StageSum[] {
  return STAGES.flatMap((stage) => {
    const mine = rows.flatMap((r) => r.stages).filter((s) => s.stage === stage);
    return mine.length === 0 ? [] : [{ stage, usd: mine.reduce((a, s) => a + s.usd, 0), wallMs: mine.reduce((a, s) => a + s.wallMs, 0), costUnknown: mine.some((s) => s.costUnknown) }];
  });
}

/** A reused or cached stage's child run was paid for by an earlier run, so only a stage this run ran contributes its steps. */
function stepsOf(runs: WorkflowRunStore, held: readonly Held[]): StepSum[] {
  const acc = new Map<string, StepSum & { agents: Set<string> }>();
  for (const { record, status } of held) {
    const child = status === "reused" || status === "cached" || !record.childRunId ? undefined : runs.get(record.childRunId);
    for (const result of Object.values(child?.stepResults ?? {})) {
      if (!result.usage) continue;
      const key = `${record.stage}/${result.stepId}`;
      const sum = acc.get(key) ?? { stage: record.stage, stepId: result.stepId, agentIds: [], usd: 0, calls: 0, costUnknown: false, agents: new Set<string>() };
      if (result.agentId) sum.agents.add(result.agentId);
      acc.set(key, { ...sum, usd: sum.usd + result.usage.costUsd, calls: sum.calls + 1, costUnknown: sum.costUnknown || result.usage.costUnknown === true });
    }
  }
  return [...acc.values()].map(({ agents, ...sum }) => ({ ...sum, agentIds: [...agents].sort() }));
}

function sumByStep(parts: readonly StepSum[]): StepSum[] {
  const merged = new Map<string, StepSum>();
  for (const part of parts) {
    const key = `${part.stage}/${part.stepId}`;
    const prior = merged.get(key);
    merged.set(key, !prior ? part : {
      ...prior, usd: prior.usd + part.usd, calls: prior.calls + part.calls, costUnknown: prior.costUnknown || part.costUnknown,
      agentIds: [...new Set([...prior.agentIds, ...part.agentIds])].sort(),
    });
  }
  return [...merged.values()].sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
}

/** Every run of a video folded into one cost report: per run, per stage and per step. Reads state and run directories; writes nothing. */
export function foldVideoReport(videoId: string, host: Pick<RunHost, "dataDir">): VideoReport {
  const db = openState(host.dataDir);
  try {
    const store = new WorkflowRunStore(db);
    const runs = runsOfVideo(store, videoId);
    if (runs.length === 0) throw new Error(`no ${VIDEO_WORKFLOW} run belongs to video ${videoId}`);
    const holds = runs.map((run) => heldBy(host.dataDir, run));
    const rows = runs.map((run, i) => runRow(run, holds[i]!));
    return {
      schema: "explainer-video-report/v1", videoId, runs: rows,
      totals: { usd: rows.reduce((a, r) => a + r.usd, 0), wallMs: rows.reduce((a, r) => a + r.wallMs, 0), costUnknown: rows.some((r) => r.costUnknown) },
      byStage: sumByStage(rows), byStep: sumByStep(holds.flatMap((held) => stepsOf(store, held))),
    };
  } finally {
    db.close();
  }
}

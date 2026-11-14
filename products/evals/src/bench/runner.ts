import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seededRandom } from "@titan-design/evidence";
import { benchSettings, buildJobCommand, TRACK_TOOLS } from "./args.js";
import type { Arm, Track } from "./arms.js";
import type { GuardDecision } from "./guard.js";
import { classifyLaunch, parseCliResult, transcriptPath, type Launcher, type LaunchResult } from "./job.js";
import { appendJsonl, JOB_SCHEMA, nextAttempt, readJobRows, type JobRow, type Outcome, type TokenCounts } from "./ledger.js";

const SCORE_SCHEMA = "titan.bench-score/v1";

export interface BenchCase {
  id: string;
  hash: string;
  stratum?: Record<string, string>;
}

/** What a track hands the runner for one (case, arm) job. */
export interface PreparedJob {
  cwd: string;
  prompt: string;
  allowedTools: readonly string[];
  timeoutSecs: number;
  appendSystemPromptFile?: string;
}

/** `outcome` lets a scorer void a job (`contaminated`) after reading what it did. */
export interface TrackScore {
  result: unknown;
  outcome?: Outcome;
}

/** The seam each track slice implements; the runner owns spawning, ledgers, resume, guards and concurrency. */
export interface TrackPlugin<C extends BenchCase = BenchCase> {
  track: Track;
  prepare(benchCase: C, arm: Arm, jobDir: string): Promise<PreparedJob>;
  score(job: JobRow, benchCase: C, prepared: PreparedJob): Promise<TrackScore>;
  cleanup(benchCase: C, arm: Arm, prepared: PreparedJob): Promise<void>;
}

export interface MeterReading {
  tokens: Record<string, TokenCounts>;
  listUsd: number | null;
  effortSeen: string[];
  modelSeen: string[];
  sidechainLines: number;
  cliMismatch: boolean;
  outcome: "ok" | "arm-mismatch";
}

/** Supplied by the meter slice; without one the row's token and cost fields stay null. */
export type Meter = (input: { transcriptPath: string; arm: Arm; cliResult?: unknown }) => Promise<MeterReading>;

export interface RunOptions<C extends BenchCase> {
  plugin: TrackPlugin<C>;
  cases: readonly C[];
  arms: readonly Arm[];
  outDir: string;
  configDir: string;
  /** The real home whose operator state the settings deny Reads of; jobs themselves get a fresh HOME. */
  operatorHome: string;
  osSandbox?: boolean;
  jobPath: string;
  seed: string;
  launcher: Launcher;
  guard: () => Promise<GuardDecision>;
  meter?: Meter;
  maxInflight?: number;
  limitBlocks?: number;
  newSessionId?: () => string;
  clock?: () => Date;
  log?: (line: string) => void;
}

interface RunSummary {
  dispatched: number;
  skipped: number;
  stopped?: string;
}

interface PlannedJob<C> {
  track: Track;
  benchCase: C;
  arm: Arm;
  block: number;
  attempt: number;
}

/** Fisher-Yates on a per-block seed, so the arm order is stable across restarts but differs between blocks. */
export function shuffledArms(arms: readonly Arm[], seed: string, caseHash: string): Arm[] {
  const random = seededRandom(`${seed}:${caseHash}`);
  const order = [...arms];
  for (let index = order.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    const [current, picked] = [order[index], order[swap]];
    if (current !== undefined && picked !== undefined) [order[index], order[swap]] = [picked, current];
  }
  return order;
}

/** Block-major: every arm of block k is queued before any arm of block k+1, so a stop leaves whole blocks behind it. */
function planJobs<C extends BenchCase>(options: RunOptions<C>, rows: readonly JobRow[]): { jobs: PlannedJob<C>[]; skipped: number } {
  const blocks = options.cases.slice(0, options.limitBlocks ?? options.cases.length);
  let skipped = 0;
  const jobs = blocks.flatMap((benchCase, block) =>
    shuffledArms(options.arms, options.seed, benchCase.hash).flatMap((arm) => {
      const attempt = nextAttempt(rows, arm.id, benchCase.hash);
      if (attempt === null) skipped++;
      return attempt === null ? [] : [{ track: options.plugin.track, benchCase, arm, block, attempt }];
    }),
  );
  return { jobs, skipped };
}

export async function runBench<C extends BenchCase>(options: RunOptions<C>): Promise<RunSummary> {
  mkdirSync(join(options.outDir, "transcripts"), { recursive: true });
  mkdirSync(join(options.outDir, "results"), { recursive: true });
  const settings = benchSettings(TRACK_TOOLS[options.plugin.track].denied, { operatorHome: options.operatorHome, jobsDir: join(options.outDir, "jobs"), osSandbox: options.osSandbox === true });
  writeFileSync(settingsPathOf(options), `${JSON.stringify(settings, null, 2)}\n`);
  const { jobs, skipped } = planJobs(options, readJobRows(join(options.outDir, "jobs.jsonl")));
  const limit = options.maxInflight ?? 6;
  const inflight = new Set<Promise<void>>();
  let dispatched = 0;
  for (const job of jobs) {
    while (inflight.size >= limit) await Promise.race(inflight);
    const decision = await options.guard();
    if (!decision.go) return { dispatched, skipped, stopped: await stopRun(options, inflight, decision.reason) };
    const running: Promise<void> = runJob(options, job).finally(() => inflight.delete(running));
    inflight.add(running);
    dispatched++;
  }
  await Promise.all(inflight);
  return { dispatched, skipped };
}

async function stopRun<C extends BenchCase>(options: RunOptions<C>, inflight: Set<Promise<void>>, reason: string): Promise<string> {
  writeFileSync(join(options.outDir, "STOPPED"), `${reason}\n`);
  options.log?.(`bench: stopped dispatching, ${reason}; waiting for ${inflight.size} in-flight job(s)`);
  await Promise.all(inflight);
  return reason;
}

const settingsPathOf = (options: { outDir: string }): string => join(options.outDir, "bench-settings.json");
const jobDirOf = (outDir: string, job: PlannedJob<BenchCase>): string => join(outDir, "jobs", `${job.benchCase.hash.slice(0, 16)}-${job.arm.id}`);
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Launched {
  sessionId: string;
  transcript: string;
  startedAt: Date;
  endedAt: Date;
  result: LaunchResult;
}

/** Never rejects: a harness failure becomes an `infra` row, so the pool keeps draining and resume retries it once. */
async function runJob<C extends BenchCase>(options: RunOptions<C>, job: PlannedJob<C>): Promise<void> {
  const jobDir = jobDirOf(options.outDir, job);
  rmSync(jobDir, { recursive: true, force: true });
  mkdirSync(join(jobDir, "home"), { recursive: true });
  const sessionId = (options.newSessionId ?? randomUUID)();
  const startedAt = (options.clock ?? (() => new Date()))();
  try {
    const prepared = await options.plugin.prepare(job.benchCase, job.arm, jobDir);
    const launched = await launch(options, job.arm, prepared, jobDir, sessionId);
    await finishJob(options, job, prepared, launched);
  } catch (error) {
    options.log?.(`bench: ${job.arm.id} ${job.benchCase.id}: ${errorText(error)}`);
    const failed: Launched = { sessionId, transcript: "", startedAt, endedAt: (options.clock ?? (() => new Date()))(), result: { code: null, stdout: "", stderr: "" } };
    appendJsonl(join(options.outDir, "jobs.jsonl"), jobRow(job, failed, "infra", undefined));
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
}

async function launch<C extends BenchCase>(options: RunOptions<C>, arm: Arm, prepared: PreparedJob, jobDir: string, sessionId: string): Promise<Launched> {
  const clock = options.clock ?? (() => new Date());
  const command = buildJobCommand({
    arm,
    jobDir,
    sessionId,
    ...prepared,
    configDir: options.configDir,
    path: options.jobPath,
    settingsPath: settingsPathOf(options),
    deniedTools: TRACK_TOOLS[options.plugin.track].denied,
  });
  const startedAt = clock();
  const result = await options.launcher(command);
  return { sessionId, transcript: transcriptPath(options.configDir, prepared.cwd, sessionId), startedAt, endedAt: clock(), result };
}

/** Score before the row is written, so a scorer that voids the job (`contaminated`) is the row's final word. */
async function finishJob<C extends BenchCase>(options: RunOptions<C>, job: PlannedJob<C>, prepared: PreparedJob, launched: Launched): Promise<void> {
  const reading = await meterJob(options, job.arm, launched);
  const launchOutcome = classifyLaunch(launched.result);
  const outcome = launchOutcome === "ok" && reading?.outcome === "arm-mismatch" ? "arm-mismatch" : launchOutcome;
  const row = jobRow(job, launched, outcome, reading);
  const scored = await scoreJob(options, job, prepared, row);
  const final = { ...row, outcome: scored.outcome ?? row.outcome };
  archive(options.outDir, launched);
  appendJsonl(join(options.outDir, "jobs.jsonl"), final);
  const { id: caseId, hash: caseHash } = job.benchCase;
  const scoreRow = { schema: SCORE_SCHEMA, track: job.track, arm: job.arm.id, caseId, caseHash, attempt: job.attempt, outcome: final.outcome, result: scored.result };
  appendJsonl(join(options.outDir, "scores.jsonl"), scoreRow);
  const logCleanup = (error: unknown) => options.log?.(`bench: cleanup failed for ${launched.sessionId}: ${errorText(error)}`);
  await options.plugin.cleanup(job.benchCase, job.arm, prepared).catch(logCleanup);
}

async function meterJob<C extends BenchCase>(options: RunOptions<C>, arm: Arm, launched: Launched): Promise<MeterReading | undefined> {
  if (options.meter === undefined || !existsSync(launched.transcript)) return undefined;
  try {
    return await options.meter({ transcriptPath: launched.transcript, arm, cliResult: parseCliResult(launched.result.stdout) });
  } catch (error) {
    options.log?.(`bench: meter failed for ${launched.sessionId}: ${errorText(error)}`);
    return undefined;
  }
}

async function scoreJob<C extends BenchCase>(options: RunOptions<C>, job: PlannedJob<C>, prepared: PreparedJob, row: JobRow): Promise<TrackScore> {
  try {
    return await options.plugin.score(row, job.benchCase, prepared);
  } catch (error) {
    return { result: { scoreError: errorText(error) }, outcome: "error" };
  }
}

/** The transcript and the CLI's JSON result outlive the job dir; claude's own copy may be pruned later. */
function archive(outDir: string, launched: Launched): void {
  writeFileSync(join(outDir, "results", `${launched.sessionId}.json`), launched.result.stdout);
  if (launched.result.stderr !== "") writeFileSync(join(outDir, "results", `${launched.sessionId}.stderr`), launched.result.stderr);
  if (existsSync(launched.transcript)) copyFileSync(launched.transcript, join(outDir, "transcripts", `${launched.sessionId}.jsonl`));
}

function jobRow(job: PlannedJob<BenchCase>, launched: Launched, outcome: Outcome, reading: MeterReading | undefined): JobRow {
  const { startedAt, endedAt } = launched;
  return {
    schema: JOB_SCHEMA,
    track: job.track,
    arm: job.arm,
    caseId: job.benchCase.id,
    caseHash: job.benchCase.hash,
    block: job.block,
    stratum: job.benchCase.stratum ?? null,
    attempt: job.attempt,
    sessionId: launched.sessionId,
    transcript: launched.transcript,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    seconds: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
    exit: { code: launched.result.code, timedOut: outcome === "timeout" },
    outcome,
    tokens: reading?.tokens ?? null,
    listUsd: reading?.listUsd ?? null,
    effortSeen: reading?.effortSeen ?? null,
    modelSeen: reading?.modelSeen ?? null,
  };
}

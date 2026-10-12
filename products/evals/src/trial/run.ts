import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { caseHash, sha256Hex, variantHash } from "../hash.js";
import { parseTrialRecord, type EvalCase, type TrialRecord, type UnitSpec, type VariantSpec } from "../spec/index.js";
import { startTrial, type ChampionOf } from "../trial.js";
import { agentRoute, type TrialSandbox } from "./agent-route.js";
import { createTrialHost, type TrialTopology } from "./host.js";
import type { TrialOutcome, TrialRunRecord } from "./record.js";
import type { TrialLaunch } from "./routes.js";

/** Where one trial keeps everything it writes, so a crashed run can tell finished trials from unfinished ones. */
export interface TrialDirs extends TrialSandbox {
  root: string;
  dbPath: string;
  recordPath: string;
}

export interface TrialVariant {
  variant: VariantSpec;
  topology: TrialTopology;
}

export interface RunTrialsOptions {
  /** One directory per run; re-running with the same `runDir` and `runId` resumes it. */
  runDir: string;
  runId: string;
  unit: UnitSpec;
  variants: readonly TrialVariant[];
  cases: readonly EvalCase[];
  /** Trials per variant and case. */
  trials: number;
  /** Builds a trial's launch port; defaults to `agentRoute(dirs)`, which runs `runAgent` in the trial's sandbox. */
  launchFor?: (dirs: TrialDirs) => TrialLaunch;
  /** Needed only by variants with `"champion"` children. */
  championOf?: ChampionOf;
  /** Stops the run between dispatches and leaves the current trial unfinished on disk, as a crash would. */
  signal?: AbortSignal;
  now?: () => number;
  leaseMs?: number;
}

interface PlannedTrial {
  trialId: string;
  variant: TrialVariant;
  evalCase: EvalCase;
}

/** The pure identity of one trial in one run (design 1.8 rule 5). */
export function trialId(variantHashHex: string, caseHashHex: string, trialIndex: number, runId: string): string {
  return sha256Hex(JSON.stringify([variantHashHex, caseHashHex, trialIndex, runId]));
}

export function trialDirs(runDir: string, id: string): TrialDirs {
  const root = join(runDir, id);
  return {
    root,
    dbPath: join(root, "trial.sqlite3"),
    recordPath: join(root, "record.json"),
    workspace: join(root, "workspace"),
    configDir: join(root, "config"),
  };
}

/** Runs every variant on every case `trials` times, one trial at a time, skipping trials a previous run settled. */
export async function runTrials(options: RunTrialsOptions): Promise<TrialRunRecord[]> {
  const records: TrialRunRecord[] = [];
  for (const planned of planTrials(options)) {
    options.signal?.throwIfAborted();
    records.push(await settleTrial(planned, options));
  }
  return records;
}

function planTrials(options: RunTrialsOptions): PlannedTrial[] {
  return options.variants.flatMap((variant) => {
    const ofVariant = variantHash(variant.variant);
    return options.cases.flatMap((evalCase) => {
      const ofCase = caseHash(evalCase);
      return Array.from({ length: options.trials }, (_, index) => ({ trialId: trialId(ofVariant, ofCase, index, options.runId), variant, evalCase }));
    });
  });
}

/** An infra trial says nothing about the variant, so it is run once more from scratch before it is recorded (design 1.6). */
async function settleTrial(planned: PlannedTrial, options: RunTrialsOptions): Promise<TrialRunRecord> {
  const dirs = trialDirs(options.runDir, planned.trialId);
  if (existsSync(dirs.recordPath)) return readRecord(dirs.recordPath);
  const infraPath = join(dirs.root, "infra.json");
  let record = await runTrial(planned, dirs, options);
  if (record.outcome === "infra" && !existsSync(infraPath)) {
    writeJsonAtomic(infraPath, record);
    resetSandbox(dirs);
    record = await runTrial(planned, dirs, options);
  }
  writeJsonAtomic(dirs.recordPath, record);
  return record;
}

async function runTrial(planned: PlannedTrial, dirs: TrialDirs, options: RunTrialsOptions): Promise<TrialRunRecord> {
  const resuming = existsSync(dirs.dbPath);
  mkdirSync(dirs.workspace, { recursive: true });
  mkdirSync(dirs.configDir, { recursive: true });
  const identity = await trialIdentity(planned, dirs, options);
  const { variant, topology } = planned.variant;
  const launch = (options.launchFor ?? ((sandbox: TrialDirs) => agentRoute(sandbox)))(dirs);
  const host = createTrialHost({ variant, topology, dbPath: dirs.dbPath, launch, now: options.now, leaseMs: options.leaseMs });
  try {
    const input = { trialId: planned.trialId, identity, params: caseParams(planned.evalCase) };
    return await untilAborted(resuming ? host.resume(input) : host.run(input), options.signal);
  } finally {
    host.close();
  }
}

/** Written once, so a resumed trial keeps the identity, start time and champions it began with. */
async function trialIdentity(planned: PlannedTrial, dirs: TrialDirs, options: RunTrialsOptions): Promise<TrialRecord> {
  const path = join(dirs.root, "identity.json");
  if (existsSync(path)) return parseTrialRecord(readJson(path), "strict");
  const identity = await startTrial({
    unit: options.unit,
    variant: planned.variant.variant,
    caseHash: caseHash(planned.evalCase),
    startedAt: new Date((options.now ?? Date.now)()).toISOString(),
    championOf: options.championOf ?? noChampions,
  });
  writeJsonAtomic(path, identity);
  return identity;
}

const noChampions: ChampionOf = (unit) => {
  throw new Error(`runTrials was given no championOf, and a variant names the champion of ${unit.id}@${unit.version}`);
};

/** A case's top-level inputs become the topology's `ctx.param`s; a non-string input is passed as JSON. */
function caseParams(evalCase: EvalCase): Record<string, string> {
  if (typeof evalCase.input !== "object" || evalCase.input === null) return { input: JSON.stringify(evalCase.input) };
  return Object.fromEntries(Object.entries(evalCase.input).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  work.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function resetSandbox(dirs: TrialDirs): void {
  for (const path of [dirs.dbPath, `${dirs.dbPath}-wal`, `${dirs.dbPath}-shm`, dirs.workspace, dirs.configDir]) rmSync(path, { recursive: true, force: true });
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const OUTCOMES: ReadonlySet<unknown> = new Set<TrialOutcome>(["passed-run", "failed", "infra"]);

/** Only this module writes the file, so a shape check guards against a foreign or hand-edited file, not drift. */
function isTrialRunRecord(value: unknown): value is TrialRunRecord {
  if (typeof value !== "object" || value === null) return false;
  if (!("trialId" in value && "outcome" in value && "attempts" in value && "calls" in value)) return false;
  return typeof value.trialId === "string" && OUTCOMES.has(value.outcome) && Array.isArray(value.attempts) && Array.isArray(value.calls);
}

function readRecord(path: string): TrialRunRecord {
  const value = readJson(path);
  if (!isTrialRunRecord(value)) throw new Error(`${path} is not a trial record; delete it to re-run the trial`);
  return value;
}

/** A rename is atomic, so a crash leaves either no record or a whole one, never a torn file read as settled. */
function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { EXIT } from "@titan-design/registry";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { EXIT_LOCKED, tryLock } from "./graph-refresh.js";
import { ADOPTION_OPPORTUNITIES, type AdoptionOpportunity } from "./insights/adoption-registry.js";
import { toolAdoptionReport, toolAdoptionSchema, type ToolAdoptionPorts } from "./insights/tool-adoption.js";
import { toolGapsReport, toolGapsSchema, type ToolGapsPorts } from "./insights/tool-gaps.js";
import {
  DEFAULT_GAP_THRESHOLD,
  diffWeeks,
  planTaskActions,
  renderDigest,
  trackedPatterns,
  type GapThreshold,
  type OpenTask,
  type TaskAction,
  type WeekSnapshot,
} from "./tool-gap-weekly.js";

/** Task filing crosses into active-work's own CLI; tests inject a fake. */
export interface ActiveWorkPort {
  openTasks(initiative: string, tag: string): Promise<OpenTask[]>;
  add(initiative: string, action: Extract<TaskAction, { kind: "add" }>): Promise<void>;
  note(initiative: string, action: Extract<TaskAction, { kind: "note" }>): Promise<void>;
}

export interface ToolGapWeeklyOptions {
  db: Db;
  /** Holds `latest.json` and the run lock. */
  dir: string;
  initiative: string;
  threshold?: GapThreshold;
  registry?: readonly AdoptionOpportunity[];
  /** `now` here also ends the 7-day window Q9 reads. */
  reports: ToolGapsPorts & ToolAdoptionPorts;
  activeWork: ActiveWorkPort;
  /** Receives the one digest; it reports and asks nothing. */
  notify(digest: string): Promise<void>;
  log(line: string): void;
}

export type ToolGapWeeklyResult =
  | { outcome: "locked"; exitCode: typeof EXIT_LOCKED }
  | { outcome: "failed"; error: string; exitCode: number }
  | { outcome: "ok"; actions: { kind: TaskAction["kind"]; patternId: string }[]; exitCode: number };

const WEEK_MS = 7 * 86_400_000;
/** Far past the threshold's reach, so the diff sees every row that could have crossed it. */
const GAP_ROWS = 500;
const TOOL_GAP_TAG = "tool-gap";

export const snapshotPath = (dir: string) => path.join(dir, "latest.json");

export const weekSnapshotSchema: z.ZodType<WeekSnapshot> = z.object({ gaps: toolGapsSchema, adoption: toolAdoptionSchema });

const openTasksEnvelope = z.object({ data: z.object({ tasks: z.array(z.object({ id: z.string(), tags: z.array(z.string()) })) }) });

/**
 * One weekly pass: run Q9 and Q10 over the last 7 days, file or note one task per pattern, send the
 * digest, and only then replace last week's snapshot, so a failed pass is retried against the same base.
 */
export async function runToolGapWeekly(options: ToolGapWeeklyOptions): Promise<ToolGapWeeklyResult> {
  const lockPath = path.join(options.dir, "run.lock");
  if (tryLock(lockPath) !== "acquired") {
    options.log(`tool-gap-weekly: another run holds ${lockPath}; exiting`);
    return { outcome: "locked", exitCode: EXIT_LOCKED };
  }
  try {
    return await weeklyPass(options);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    options.log(`tool-gap-weekly: FAILED: ${error}`);
    return { outcome: "failed", error, exitCode: EXIT.SOFTWARE };
  } finally {
    rmSync(lockPath, { force: true });
  }
}

async function weeklyPass(options: ToolGapWeeklyOptions): Promise<ToolGapWeeklyResult> {
  const registry = options.registry ?? ADOPTION_OPPORTUNITIES;
  const current = await readWeek(options, registry);
  const previous = readSnapshot(options.dir);
  const open = await options.activeWork.openTasks(options.initiative, TOOL_GAP_TAG);
  const actions = planTaskActions(current.gaps.patterns, trackedPatterns(registry), open, options.threshold ?? DEFAULT_GAP_THRESHOLD);
  for (const action of actions) {
    if (action.kind === "add") await options.activeWork.add(options.initiative, action);
    else await options.activeWork.note(options.initiative, action);
  }
  await options.notify(renderDigest(diffWeeks(previous, current), actions, current.adoption));
  writeSnapshot(options.dir, current);
  options.log(`tool-gap-weekly: ${actions.length} task actions; snapshot written`);
  return { outcome: "ok", actions: actions.map(({ kind, patternId }) => ({ kind, patternId })), exitCode: EXIT.OK };
}

async function readWeek(options: ToolGapWeeklyOptions, registry: readonly AdoptionOpportunity[]): Promise<WeekSnapshot> {
  const until = options.reports.now();
  const report = { since: new Date(until.getTime() - WEEK_MS).toISOString(), until: until.toISOString() };
  const gaps = await toolGapsReport(options.db, report, GAP_ROWS, options.reports);
  const adoption = await toolAdoptionReport(options.db, report, options.reports, registry);
  return { gaps, adoption };
}

function readSnapshot(dir: string): WeekSnapshot | null {
  if (!existsSync(snapshotPath(dir))) return null;
  return weekSnapshotSchema.parse(JSON.parse(readFileSync(snapshotPath(dir), "utf8")));
}

function writeSnapshot(dir: string, week: WeekSnapshot): void {
  mkdirSync(dir, { recursive: true });
  const tmp = `${snapshotPath(dir)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(week, null, 2)}\n`);
  renameSync(tmp, snapshotPath(dir));
}

const execFileAsync = promisify(execFile);

/** The active-work CLI on PATH, through its JSON envelope. */
export const activeWorkCli: ActiveWorkPort = {
  async openTasks(initiative, tag) {
    const { stdout } = await execFileAsync("active-work", ["--json", "task", "list", initiative, "--tag", tag]);
    return openTasksEnvelope.parse(JSON.parse(stdout)).data.tasks;
  },
  async add(initiative, action) {
    await execFileAsync("active-work", ["task", "add", initiative, "--title", action.title, "--tags", action.tags.join(","), "--notes", action.body]);
  },
  async note(initiative, action) {
    await execFileAsync("active-work", ["task", "note", initiative, action.taskId, action.text]);
  },
};

/** Runs the operator's notifier with the digest on stdin; no shell, so the path is taken literally. */
export function notifyCommand(command: string): (digest: string) => Promise<void> {
  return (digest) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, [], { stdio: ["pipe", "inherit", "inherit"] });
      child.on("error", reject);
      child.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${signal ?? code}`))));
      child.stdin.end(digest);
    });
}

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnExec, type Exec } from "@titan-design/fix-proof";
import { z } from "zod";
import { hashCanonical } from "../../hash.js";
import { assertNoLaterHistory } from "../../implement-task/workspace.js";
import { TRACK_TIMEOUT_SECS, TRACK_TOOLS } from "../args.js";
import type { JobRow } from "../ledger.js";
import { finalMessage } from "../review/score.js";
import type { BenchCase, PreparedJob, TrackPlugin, TrackScore } from "../runner.js";
import { auditJob, type AuditResult } from "./audit.js";
import { KINDS, PKG_GROUPS, SIZES, stratifiedQueue } from "./corpus.js";
import { copyPreparedBase } from "./prepare.js";
import { scoreTree, seedCorepack, type ImplementResult } from "./score.js";

const CaseRow = z.looseObject({
  candidate: z.string(),
  id: z.string().nullable(),
  taskId: z.string(),
  kind: z.enum(KINDS),
  size: z.enum(SIZES),
  pkgGroup: z.enum(PKG_GROUPS),
  mergeSha: z.string(),
  baseSha: z.string(),
  brief: z.string().nullable(),
  hiddenTests: z.array(z.string()),
  verdict: z.string(),
  nonTestLines: z.number(),
});

export interface ImplementCase extends BenchCase {
  candidate: string;
  taskId: string;
  kind: z.infer<typeof CaseRow>["kind"];
  size: z.infer<typeof CaseRow>["size"];
  pkgGroup: z.infer<typeof CaseRow>["pkgGroup"];
  mergeSha: string;
  baseSha: string;
  brief: string;
  hiddenTests: string[];
  nonTestLines: number;
}

function caseOf(row: z.infer<typeof CaseRow>, id: string, brief: string): ImplementCase {
  const { candidate, taskId, kind, size, pkgGroup, mergeSha, baseSha, hiddenTests, nonTestLines } = row;
  const hash = hashCanonical({ id, mergeSha, brief, hiddenTests });
  return { id, hash, candidate, taskId, kind, size, pkgGroup, mergeSha, baseSha, brief, hiddenTests, nonTestLines, stratum: { kind, size, pkg: pkgGroup } };
}

/** Kept cases of `<dir>/cases.jsonl` in the screen's own stratified order (kind x size x package group, round-robin). */
export function loadImplementQueue(dir: string, seed: string): ImplementCase[] {
  const lines = readFileSync(join(dir, "cases.jsonl"), "utf8").split("\n").filter((line) => line.trim() !== "");
  const kept = lines.flatMap((line) => {
    const row = CaseRow.parse(JSON.parse(line));
    return row.verdict === "keep" && row.id !== null && row.brief !== null && row.hiddenTests.length > 0 ? [caseOf(row, row.id, row.brief)] : [];
  });
  return stratifiedQueue(kept, seed, (benchCase) => benchCase.candidate);
}

/** Design 1-I, identical across arms; the brief is the scrubbed `Task:` / `Done when:` pair. */
export function implementPrompt(taskId: string, brief: string): string {
  const lead = [
    `You are implementing task ${taskId} in this repository. The repository is checked out at the commit the task was briefed against.`,
    "Do the task completely: write the code and the tests the task needs, run the touched package's typecheck and tests",
    "(prefix vitest with NODE_OPTIONS=--max-old-space-size=4096 and `timeout 900`), and stop when done.",
    "There is no network, no GitHub, no remote; do not push or open a PR. Commit your work with git when finished.",
  ].join(" ");
  return `${lead}\n\n${brief}`;
}

/** At most `limit` callers inside at once; the rest queue in arrival order and inherit a leaver's slot directly. */
export function semaphore(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) active--;
      else next();
    }
  };
}

interface ImplementTrackOptions {
  casesDir: string;
  preparedRoot: string;
  /** The run dir; each job's patch and final message are kept under `<runDir>/artifacts`. */
  runDir: string;
  /** The real home a job must never read; the trace audit names hits under it. */
  operatorHome?: string;
  exec?: Exec;
  /** PATH for scoring commands (pnpm, node, git). */
  path?: string;
  /** Where the runner's corepack keeps pnpm (default: $COREPACK_HOME or ~/.cache/node/corepack). */
  corepackHome?: string;
  /** Scorers at once across the run: each builds and runs vitest. */
  maxScorers?: number;
}

const GIT_IDENTITY = [
  ["user.name", "bench"],
  ["user.email", "bench@example.invalid"],
] as const;

/** git needs an identity to commit, and the job's HOME is empty, so the workspace carries one of its own. */
async function prepareWorkspace(benchCase: ImplementCase, ws: string, options: ImplementTrackOptions, exec: Exec): Promise<string> {
  await copyPreparedBase(benchCase.id, ws, { preparedRoot: options.preparedRoot, exec });
  await assertNoLaterHistory(ws, benchCase.mergeSha);
  for (const [key, value] of GIT_IDENTITY) {
    const set = await exec("git", ["-C", ws, "config", key, value], { cwd: ws, timeoutMs: 60_000 });
    if (set.status !== 0) throw new Error(`git config ${key} failed: ${set.stderr.trim()}`);
  }
  const head = await exec("git", ["-C", ws, "rev-parse", "HEAD"], { cwd: ws, timeoutMs: 60_000 });
  if (head.status !== 0) throw new Error(`no root commit in ${ws}: ${head.stderr.trim()}`);
  return head.stdout.trim();
}

function saveArtifact(runDir: string, name: string, text: string): void {
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", name), text);
}

export const corepackHomeOf = (options: { corepackHome?: string }): string =>
  options.corepackHome ?? process.env.COREPACK_HOME ?? join(homedir(), ".cache", "node", "corepack");

const workDirOf =(prepared: PreparedJob): string => join(dirname(prepared.cwd), "score");

interface ImplementScore {
  audit: AuditResult | null;
  score?: ImplementResult;
}

interface TrackState {
  options: ImplementTrackOptions;
  exec: Exec;
  /** Each workspace's seeded root commit, read before the arm could rewrite history. */
  roots: Map<string, string>;
  limited: ReturnType<typeof semaphore>;
}

/** Audit first: a voided job's tree is never built or tested. */
async function scoreJob(state: TrackState, job: JobRow, benchCase: ImplementCase, prepared: PreparedJob): Promise<TrackScore> {
  const { options } = state;
  const message = existsSync(job.transcript) ? finalMessage(readFileSync(job.transcript, "utf8")) : undefined;
  saveArtifact(options.runDir, `${job.sessionId}.md`, message ?? "");
  const auditRoots = { workspace: prepared.cwd, jobHome: join(dirname(prepared.cwd), "home"), operatorHome: options.operatorHome ?? homedir() };
  const audit = auditJob(job.transcript, auditRoots);
  if (audit?.contaminated === true) return { result: { audit } satisfies ImplementScore, outcome: "contaminated" };
  const rootSha = state.roots.get(prepared.cwd);
  if (rootSha === undefined) throw new Error(`no root commit recorded for ${prepared.cwd}`);
  const score = await state.limited(() =>
    scoreTree({
      benchCase,
      workspace: prepared.cwd,
      workDir: workDirOf(prepared),
      rootSha,
      hiddenDir: join(options.casesDir, "hidden", benchCase.id),
      patchPath: join(options.runDir, "artifacts", `${job.sessionId}.patch`),
      exec: state.exec,
      path: options.path ?? process.env.PATH ?? "",
      corepackHome: corepackHomeOf(options),
    }),
  );
  return { result: { audit, score } satisfies ImplementScore };
}

/** Track I: a full copy of the prepared base per arm, scored after exit on a fresh copy, at most two scorers at once. */
export function implementTrack(options: ImplementTrackOptions): TrackPlugin<ImplementCase> {
  const state: TrackState = { options, exec: options.exec ?? spawnExec, roots: new Map(), limited: semaphore(options.maxScorers ?? 2) };
  return {
    track: "i",
    prepare: async (benchCase, _arm, jobDir): Promise<PreparedJob> => {
      const cwd = join(jobDir, "ws");
      state.roots.set(cwd, await prepareWorkspace(benchCase, cwd, options, state.exec));
      seedCorepack(join(jobDir, "home", ".cache", "node", "corepack"), cwd, corepackHomeOf(options));
      const prepared = { cwd, prompt: implementPrompt(benchCase.taskId, benchCase.brief), allowedTools: TRACK_TOOLS.i.allowed, timeoutSecs: TRACK_TIMEOUT_SECS.i };
      const claudeMd = join(cwd, "CLAUDE.md");
      return existsSync(claudeMd) ? { ...prepared, appendSystemPromptFile: claudeMd } : prepared;
    },
    score: (job, benchCase, prepared) => scoreJob(state, job, benchCase, prepared),
    cleanup: (_benchCase, _arm, prepared): Promise<void> => {
      state.roots.delete(prepared.cwd);
      rmSync(prepared.cwd, { recursive: true, force: true });
      rmSync(workDirOf(prepared), { recursive: true, force: true });
      return Promise.resolve();
    },
  };
}


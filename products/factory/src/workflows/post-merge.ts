import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type { RepoSlug } from "@titan-design/github";
import type { DurableStepOutcome, RecoverableActiveStep, RoutedStepInput, StepReconcileOutcome, StepRoute, StepRunOutcome, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { PostMergeConfig } from "../config.js";
import type { StepDeclaration } from "../definition.js";
import { evidenceRecord, type StepAttempt } from "../evidence.js";
import { redactCredentials, redactForEvidence } from "../redact.js";
import { step } from "./land.js";
import { ChoreSpec, awaitChoreResult, choreFiles, choreState, handleName, launchChore, writeJson, type ChorePorts } from "./post-merge-chore.js";

export const POST_MERGE_STEPS: readonly StepDeclaration[] = [{ id: "post-merge", kind: "dispatch" }];
export const POST_MERGE_TIMEOUT_MS = 10 * 60_000;
export const POST_MERGE_PIPE_GRACE_MS = 2_000;
export const TAIL_CHARS = 2_000;
export const NO_COMMAND = "no post-merge command";
/** Output kept per stream before the tail is cut; wide enough that redaction sees any token near the kept tail whole. */
const KEPT_CHARS = 64 * 1024;

export interface PostMergeInput {
  repo: RepoSlug;
  pr: number;
  mergeSha: string | null;
}

export interface ChoreOptions {
  cwd?: string;
  timeoutMs: number;
  /** How long after the chore exits its output may stay open, held by a daemon it left behind, before the result is taken. */
  pipeGraceMs?: number;
  env: NodeJS.ProcessEnv;
}

export interface ChoreResult {
  exitCode: number | null;
  signal: string | null;
  /** True when the chore outlived its timeout and its process group was killed. */
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Why the chore did not run to an exit, such as a missing program; absent for any exit code. */
  error?: string;
}

export type ChoreExec = (argv: readonly [string, ...string[]], options: ChoreOptions) => Promise<ChoreResult>;

/** Runs argv with no shell and always resolves: a failed chore is evidence, since the merge already happened. */
export function execChore(argv: readonly [string, ...string[]], options: ChoreOptions): Promise<ChoreResult> {
  const [file, ...args] = argv;
  return new Promise((resolve) => {
    try {
      const child = spawn(file, args, { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      watchChore(child, options, resolve);
    } catch (error) {
      resolve({ exitCode: null, signal: null, timedOut: false, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function watchChore(child: ChildProcess, options: ChoreOptions, resolve: (result: ChoreResult) => void): void {
  const stdout = keptTail(child.stdout!);
  const stderr = keptTail(child.stderr!);
  let timedOut = false;
  let graceTimer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    timedOut = true;
    killGroup(child);
  }, options.timeoutMs);
  const settle = (outcome: Pick<ChoreResult, "exitCode" | "signal" | "error">) => {
    clearTimeout(timer);
    clearTimeout(graceTimer);
    child.stdout?.destroy();
    child.stderr?.destroy();
    resolve({ ...outcome, timedOut, stdout: stdout(), stderr: stderr() });
  };
  child.on("error", (error) => settle({ exitCode: null, signal: null, error: error.message }));
  child.on("exit", (exitCode, signal) => {
    clearTimeout(timer);
    graceTimer = setTimeout(() => settle({ exitCode, signal }), options.pipeGraceMs ?? POST_MERGE_PIPE_GRACE_MS);
  });
  child.on("close", (exitCode, signal) => settle({ exitCode, signal }));
}

/** Only the latest output is kept, so a chatty chore neither grows memory without bound nor gets killed for its output. */
function keptTail(stream: NodeJS.ReadableStream): () => string {
  let text = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    text += chunk;
    if (text.length > 2 * KEPT_CHARS) text = text.slice(-KEPT_CHARS);
  });
  return () => text;
}

/** SIGKILL cannot be trapped; the group kill and closed pipes stop a grandchild from holding the step open. */
function killGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

export const PostMergeResult = z.union([
  z.looseObject({ skipped: z.literal(NO_COMMAND) }),
  z.looseObject({ exitCode: z.number().nullable(), signal: z.string().nullable(), timedOut: z.boolean(), stdoutTail: z.string(), stderrTail: z.string() }),
]);

const PostMergeInputSchema = z.object({ repo: z.string(), pr: z.number(), mergeSha: z.string().nullable() });

/** The one call land-pr makes once its PR merged; the result is recorded, never thrown, whatever the chore's exit. */
export async function postMerge(ctx: WorkflowContext, input: PostMergeInput): Promise<z.infer<typeof PostMergeResult>> {
  return step(ctx, "post-merge", input, PostMergeResult);
}

export interface PostMergeDeps {
  postMerge?: PostMergeConfig;
  runChore?: ChoreExec;
  /** Runs the chore in its own unit with a durable result, so a restart of serve neither kills it nor parks the run; absent runs it inside serve. */
  chores?: ChorePorts;
  now?: () => number;
}

/**
 * A chore such as a worktree removal or version bump may not be idempotent, so it never repeats blind: the hook reads
 * the chore's marker and result after a restart, and `park` is left for a chore run inside serve.
 */
export function postMergeRoute(deps: PostMergeDeps): StepRoute {
  const now = deps.now ?? Date.now;
  const run = async (step: RoutedStepInput): Promise<StepRunOutcome> => {
    try {
      const result = await runPostMerge(deps, PostMergeInputSchema.parse(JSON.parse(step.prompt)), step);
      return { ok: true, output: postMergeOutput(step, now(), result) };
    } catch (error) {
      return { ok: false, error: redactForEvidence(error instanceof Error ? error.message : String(error)), retryable: false };
    }
  };
  return { match: "post-merge", onRestart: "park", runner: { run }, reconcile: (step, signal) => reconcilePostMerge(deps, step, signal) };
}

const postMergeOutput = (step: StepAttempt, at: number, result: object): string => JSON.stringify(evidenceRecord("land.post-merge", step, new Date(at).toISOString(), { result }));

async function runPostMerge(deps: PostMergeDeps, input: PostMergeInput, step: RoutedStepInput): Promise<object> {
  const config = deps.postMerge;
  if (!config) return { skipped: NO_COMMAND };
  if (deps.chores) return runDurably(deps.chores, config, input, step, deps.now ?? Date.now);
  const options = { ...(config.cwd ? { cwd: config.cwd } : {}), timeoutMs: config.timeoutMs ?? POST_MERGE_TIMEOUT_MS, env: withVars(process.env, choreVars(input)) };
  return choreRecord(await (deps.runChore ?? execChore)(config.argv, options));
}

async function runDurably(chores: ChorePorts, config: PostMergeConfig, input: PostMergeInput, step: RoutedStepInput, now: () => number): Promise<object> {
  const files = choreFiles(chores.dir, step.requestKey);
  const spec: ChoreSpec = { argv: config.argv, ...(config.cwd ? { cwd: config.cwd } : {}), timeoutMs: config.timeoutMs ?? POST_MERGE_TIMEOUT_MS, vars: choreVars(input), result: files.result };
  const trace = { runId: step.runId, stepId: step.stepId, iteration: step.iteration, attempt: step.attempt };
  const handle = await launchChore(chores, files, spec, trace, new Date(now()).toISOString());
  return recordedResult(await awaitChoreResult(chores, files, handle, step.signal), handleName(handle));
}

/** The wrapper writes the record already redacted and cut; a missing or malformed one is recorded as the chore's error, never thrown. */
function recordedResult(raw: unknown, chore: string): object {
  const parsed = PostMergeResult.safeParse(raw);
  if (parsed.success) return parsed.data;
  const error = raw === undefined ? `the chore (${chore}) ended without writing a result` : `the chore (${chore}) wrote a malformed result`;
  return { exitCode: null, signal: null, timedOut: false, stdoutTail: "", stderrTail: "", error };
}

async function reconcilePostMerge(deps: PostMergeDeps, step: RecoverableActiveStep, signal: AbortSignal): Promise<StepReconcileOutcome> {
  if (!deps.postMerge) return { kind: "not_found", retrySafe: true, evidence: "no post-merge command is configured, so the step ran nothing" };
  if (!deps.chores) return { kind: "unknown", evidence: "the chore ran inside serve, so whether it finished is unknown; a human decides" };
  const { chores } = deps;
  const now = deps.now ?? Date.now;
  const files = choreFiles(chores.dir, step.requestKey);
  const state = await choreState(chores, files);
  if (state.kind === "never-started") return { kind: "not_found", retrySafe: true, evidence: "no chore marker, so the chore never started" };
  if (state.kind === "lost") return { kind: "unknown", evidence: state.why };
  const succeeded = (raw: unknown, chore: string): DurableStepOutcome => ({ kind: "succeeded", output: postMergeOutput(state.step, now(), recordedResult(raw, chore)) });
  if (state.kind === "done") return { kind: "terminal", outcome: succeeded(state.result, "recorded"), evidence: "the chore finished and wrote its result" };
  const chore = handleName(state.handle);
  const completion = awaitChoreResult(chores, files, state.handle, signal).then((raw) => succeeded(raw, chore));
  return { kind: "running", runnerRef: chore, completion, evidence: `the chore (${chore}) is still running in its own process` };
}

/** The transient unit's entry point: runs the spec's chore and leaves its record where the step, or a successor, reads it. */
export async function runChoreSpec(specFile: string): Promise<void> {
  const spec = ChoreSpec.parse(JSON.parse(readFileSync(specFile, "utf8")));
  const options = { ...(spec.cwd ? { cwd: spec.cwd } : {}), timeoutMs: spec.timeoutMs, env: withVars(process.env, spec.vars) };
  writeJson(spec.result, choreRecord(await execChore(spec.argv, options)));
}

function choreRecord(result: ChoreResult): object {
  const { exitCode, signal, timedOut, error } = result;
  return { exitCode, signal, timedOut, stdoutTail: tail(result.stdout), stderrTail: tail(result.stderr), ...(error ? { error: tail(error) } : {}) };
}

/** An unknown merge sha leaves `LAND_PR_MERGE_SHA` unset, inherited value included, so a chore never reads a stale one. */
function choreVars(input: PostMergeInput): Record<string, string | null> {
  return { LAND_PR_REPO: input.repo, LAND_PR_NUMBER: String(input.pr), LAND_PR_MERGE_SHA: input.mergeSha };
}

function withVars(base: NodeJS.ProcessEnv, vars: Record<string, string | null>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(vars)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Redacted before slicing, so a cut never leaves half a token that no longer matches the pattern. */
function tail(text: string): string {
  return redactCredentials(text).slice(-TAIL_CHARS);
}

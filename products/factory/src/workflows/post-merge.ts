import { spawn, type ChildProcess } from "node:child_process";
import type { RepoSlug } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { PostMergeConfig } from "../config.js";
import type { StepDeclaration } from "../definition.js";
import { redactCredentials } from "../redact.js";
import type { StepRoute } from "../routed-runner.js";
import { codeRoute, step } from "./land.js";

export const POST_MERGE_STEPS: readonly StepDeclaration[] = [{ id: "post-merge", kind: "dispatch" }];
export const POST_MERGE_TIMEOUT_MS = 10 * 60_000;
export const TAIL_CHARS = 2_000;
export const NO_COMMAND = "no post-merge command";
/** Output kept per stream before the tail is cut; wide enough that redaction sees any token near the kept tail whole. */
const KEPT_CHARS = 64 * 1024;

export interface PostMergeInput {
  repo: RepoSlug;
  pr: number;
  mergeSha: string;
}

export interface ChoreOptions {
  cwd?: string;
  timeoutMs: number;
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
      watchChore(child, options.timeoutMs, resolve);
    } catch (error) {
      resolve({ exitCode: null, signal: null, timedOut: false, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function watchChore(child: ChildProcess, timeoutMs: number, resolve: (result: ChoreResult) => void): void {
  const stdout = keptTail(child.stdout!);
  const stderr = keptTail(child.stderr!);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child);
  }, timeoutMs);
  const settle = (outcome: Pick<ChoreResult, "exitCode" | "signal" | "error">) => {
    clearTimeout(timer);
    resolve({ ...outcome, timedOut, stdout: stdout(), stderr: stderr() });
  };
  child.on("error", (error) => settle({ exitCode: null, signal: null, error: error.message }));
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

/** The one call land-pr makes once its PR merged; the result is recorded, never thrown, whatever the chore's exit. */
export async function postMerge(ctx: WorkflowContext, input: PostMergeInput): Promise<z.infer<typeof PostMergeResult>> {
  return step(ctx, "post-merge", input, PostMergeResult);
}

export interface PostMergeDeps {
  postMerge?: PostMergeConfig;
  runChore?: ChoreExec;
  now?: () => number;
}

/** Routed park: a chore such as a worktree removal or version bump may not be idempotent, so a crash mid-chore never repeats it. */
export function postMergeRoute(deps: PostMergeDeps): StepRoute {
  const route = codeRoute("post-merge", deps.now ?? Date.now, (input: PostMergeInput) => runPostMerge(deps, input));
  return { ...route, onRestart: "park" };
}

async function runPostMerge(deps: PostMergeDeps, input: PostMergeInput): Promise<object> {
  const config = deps.postMerge;
  if (!config) return { skipped: NO_COMMAND };
  const env = { ...process.env, LAND_PR_REPO: input.repo, LAND_PR_NUMBER: String(input.pr), LAND_PR_MERGE_SHA: input.mergeSha };
  const options = { ...(config.cwd ? { cwd: config.cwd } : {}), timeoutMs: config.timeoutMs ?? POST_MERGE_TIMEOUT_MS, env };
  const result = await (deps.runChore ?? execChore)(config.argv, options);
  const { exitCode, signal, timedOut, error } = result;
  return { exitCode, signal, timedOut, stdoutTail: tail(result.stdout), stderrTail: tail(result.stderr), ...(error ? { error: tail(error) } : {}) };
}

/** Redacted before slicing, so a cut never leaves half a token that no longer matches the pattern. */
function tail(text: string): string {
  return redactCredentials(text).slice(-TAIL_CHARS);
}

import { execFile, type ExecFileException } from "node:child_process";
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
/** Past the default 1 MiB, execFile kills the child; a chattier chore should not die for its output. */
const MAX_BUFFER = 32 * 1024 * 1024;

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
  stdout: string;
  stderr: string;
  /** Why the chore did not run to an exit, such as a missing program; absent for any exit code. */
  error?: string;
}

export type ChoreExec = (argv: readonly [string, ...string[]], options: ChoreOptions) => Promise<ChoreResult>;

/** Runs argv with no shell and always resolves: a failed chore is evidence, since the merge already happened. */
export function execChore(argv: readonly [string, ...string[]], options: ChoreOptions): Promise<ChoreResult> {
  const [file, ...args] = argv;
  const execOptions = { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: MAX_BUFFER, shell: false };
  return new Promise((resolve) => {
    execFile(file, args, execOptions, (error, stdout, stderr) => resolve({ ...exitOf(error), stdout, stderr }));
  });
}

function exitOf(error: ExecFileException | null): Pick<ChoreResult, "exitCode" | "signal" | "error"> {
  if (!error) return { exitCode: 0, signal: null };
  const exitCode = typeof error.code === "number" ? error.code : null;
  const signal = error.signal ?? null;
  return exitCode === null && signal === null ? { exitCode, signal, error: error.message } : { exitCode, signal };
}

export const PostMergeResult = z.union([
  z.looseObject({ skipped: z.literal(NO_COMMAND) }),
  z.looseObject({ exitCode: z.number().nullable(), signal: z.string().nullable(), stdoutTail: z.string(), stderrTail: z.string() }),
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
  const { exitCode, signal, error } = result;
  return { exitCode, signal, stdoutTail: tail(result.stdout), stderrTail: tail(result.stderr), ...(error ? { error: tail(error) } : {}) };
}

/** Redacted before slicing, so a cut never leaves half a token that no longer matches the pattern. */
function tail(text: string): string {
  return redactCredentials(text).slice(-TAIL_CHARS);
}

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { reviewPrBrief } from "../../review-pr/brief.js";
import { materializeBundle, type BundleGit } from "../../review-pr/bundle.js";
import { TRACK_TIMEOUT_SECS } from "../args.js";
import type { PreparedJob, TrackPlugin, TrackScore } from "../runner.js";
import type { Plant, ReviewCase } from "./cases.js";
import { finalMessage, scoreReview } from "./score.js";

const run = promisify(execFile);

/** Read-only tools only; `rg` is not listed because the hosts that run the bench do not have it. */
export const REVIEW_TOOLS = ["Read", "Grep", "Glob", "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(git diff:*)"] as const;

interface ReviewPluginOptions {
  gitFor(repo: string): BundleGit | undefined;
  /** The run dir; each job's final message is kept under `<runDir>/artifacts`. */
  runDir: string;
}

/** The planted tree's diff, from git alone; `--no-index` exits 1 whenever the trees differ, which they always do. */
async function treeDiff(bundleDir: string): Promise<string> {
  const args = ["diff", "--no-index", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "base", "head"];
  const stdout = await run("git", args, { cwd: bundleDir, maxBuffer: 1024 * 1024 * 1024 }).then(
    ({ stdout: out }) => out,
    (error: { code?: number; stdout?: string }) => {
      if (error.code === 1 && error.stdout !== undefined) return error.stdout;
      throw error;
    },
  );
  return stdout.replace(/^(diff --git |--- |\+\+\+ )(.*)$/gm, (_line, lead: string, rest: string) => lead + rest.replace(/\ba\/base\//g, "a/").replace(/\bb\/head\//g, "b/"));
}

async function plantInto(bundleDir: string, plant: Plant): Promise<void> {
  writeFileSync(join(bundleDir, "head", plant.path), plant.text);
  writeFileSync(join(bundleDir, "diff.patch"), await treeDiff(bundleDir));
}

/** Head, base and diff with no `.git`; a commit the local clone lacks fails the job as infra, and nothing is fetched. */
export async function writeBundle(benchCase: ReviewCase, bundleDir: string, gitFor: ReviewPluginOptions["gitFor"]): Promise<void> {
  if (benchCase.tree !== undefined) {
    cpSync(benchCase.tree, bundleDir, { recursive: true });
    return;
  }
  const git = gitFor(benchCase.repo);
  if (git === undefined) throw new Error(`no --repo-root names a local clone for ${benchCase.repo}`);
  await materializeBundle(git, benchCase, bundleDir).catch((error: unknown) => {
    throw new Error(`head ${benchCase.head} or base ${benchCase.base} is not in the local clone of ${benchCase.repo}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (benchCase.plant !== undefined) await plantInto(bundleDir, benchCase.plant);
}

const bundleOf = (prepared: PreparedJob): string => prepared.cwd;

function saveFinalMessage(runDir: string, sessionId: string, message: string | undefined): void {
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", `${sessionId}.md`), message ?? "");
}

/** Track R: one live reviewer brief over a bundle of the case's head, scored on its verdict block and citations. */
export function reviewPlugin(options: ReviewPluginOptions): TrackPlugin<ReviewCase> {
  return {
    track: "r",
    prepare: async (benchCase, _arm, jobDir): Promise<PreparedJob> => {
      const bundleDir = join(jobDir, "bundle");
      await writeBundle(benchCase, bundleDir, options.gitFor);
      const prompt = reviewPrBrief({ repo: benchCase.repo, pr: benchCase.pr, head: benchCase.head, checkoutRoot: jobDir }, bundleDir);
      const claudeMd = join(bundleDir, "head", "CLAUDE.md");
      const prepared = { cwd: bundleDir, prompt, allowedTools: REVIEW_TOOLS, timeoutSecs: TRACK_TIMEOUT_SECS.r };
      return existsSync(claudeMd) ? { ...prepared, appendSystemPromptFile: claudeMd } : prepared;
    },
    score: (job, benchCase, prepared): Promise<TrackScore> => {
      const message = existsSync(job.transcript) ? finalMessage(readFileSync(job.transcript, "utf8")) : undefined;
      saveFinalMessage(options.runDir, job.sessionId, message);
      return Promise.resolve({ result: scoreReview(benchCase, message, bundleOf(prepared)) });
    },
    cleanup: (_benchCase, _arm, prepared): Promise<void> => {
      rmSync(bundleOf(prepared), { recursive: true, force: true });
      return Promise.resolve();
    },
  };
}

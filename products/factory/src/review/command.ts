import { setTimeout as sleep } from "node:timers/promises";
import type { ReviewTarget } from "@titan-design/review-panel";
import type { Command } from "commander";
import type { CliIo, Verbs } from "../cli.js";
import { exitCodeOf, formatResolved, formatReview, resolveExitCode, reviewJson, type ReviewReport } from "./format.js";
import { parseTarget, type PrTarget } from "./pr-facts.js";
import { configuredReviewService, type ReviewService } from "./service.js";

interface ReviewOpts {
  head?: string;
  json?: boolean;
  waitCi?: boolean;
}

/** How `--wait-ci` waits on a head whose CI is still running. */
export interface CiWait {
  pollMs: number;
  deadlineMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const DEFAULT_CI_WAIT: CiWait = { pollMs: 30_000, deadlineMs: 60 * 60_000, now: Date.now, sleep: (ms) => sleep(ms) };

type OpenReview = (io: CliIo, factoryDb: string) => ReviewService;

const at = (pr: PrTarget, head: string): ReviewTarget => ({ ...pr, head });

/**
 * `--wait-ci` reviews again while CI is pending, and once at the current head when the head moved and no `--head` pinned it.
 * Each pass stops at preflight before any reviewer starts, so a wait spends no reviewer session.
 */
async function settled(service: ReviewService, first: ReviewReport, pr: PrTarget, pinned: boolean, wait: CiWait): Promise<ReviewReport> {
  const end = wait.now() + wait.deadlineMs;
  let report = first;
  let retargeted = false;
  for (;;) {
    const { outcome } = report;
    const moved = outcome.kind === "head-moved" && !pinned && !retargeted;
    const pending = outcome.kind === "ci-not-green" && outcome.ci === "pending";
    if ((!moved && !pending) || wait.now() >= end) return report;
    if (moved) retargeted = true;
    else await wait.sleep(wait.pollMs);
    report = await service.review(at(pr, outcome.kind === "head-moved" ? outcome.current : outcome.head));
  }
}

/** Reviews one PR head and prints its outcome; it posts nothing to GitHub and never updates the branch. */
export async function runReview(service: ReviewService, text: string, opts: ReviewOpts, io: CliIo, wait: CiWait = DEFAULT_CI_WAIT): Promise<number> {
  const pr = parseTarget(text);
  const head = await service.headOf(pr, opts.head);
  const first = await service.review(at(pr, head));
  const report = opts.waitCi ? await settled(service, first, pr, opts.head !== undefined, wait) : first;
  io.stdout(opts.json ? `${JSON.stringify(reviewJson(report))}\n` : formatReview(report));
  return exitCodeOf(report.outcome);
}

/** Reviews every run parked on the fingerprint again, each as a fresh run; the coordinator runs it once the fix is in. */
export async function runResolve(service: ReviewService, fingerprint: string, opts: { json?: boolean }, io: CliIo): Promise<number> {
  const resumed = await service.resolve(fingerprint);
  io.stdout(opts.json ? `${JSON.stringify({ fingerprint, resumed })}\n` : formatResolved(fingerprint, resumed));
  return resolveExitCode(resumed);
}

async function withService(open: OpenReview, verbs: Verbs, fn: (service: ReviewService) => Promise<number>): Promise<void> {
  const service = open(verbs.io, verbs.dbPath());
  try {
    verbs.setExit(await fn(service));
  } finally {
    service.close();
  }
}

export function registerReview(program: Command, verbs: Verbs, open: OpenReview = (io, db) => configuredReviewService(io.env, db)): void {
  const review = program
    .command("review")
    .description("Review one PR head with the review workflow, outside Shepherd; posts nothing and updates no branch")
    .argument("<target>", "owner/repo#N")
    .option("--head <sha>", "review this full head sha instead of the PR's current head")
    .option("--json", "print one JSON object: outcome, head, fingerprint and members")
    .option("--wait-ci", "wait while the head's CI is pending, and follow a moved head once")
    .action((text: string, opts: ReviewOpts) => withService(open, verbs, (service) => runReview(service, text, opts, verbs.io)));
  review
    .command("resolve")
    .description("Review every run parked on a fixer fingerprint again, once its fix is in")
    .argument("<fingerprint>", "the fingerprint a needs-fixer outcome printed")
    .option("--json", "print one JSON object with each resumed run")
    .action((fingerprint: string, opts: { json?: boolean }) => withService(open, verbs, (service) => runResolve(service, fingerprint, opts, verbs.io)));
}

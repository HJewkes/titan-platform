import { dataFence } from "@titan-design/agent-dispatch";
import type { GitHubPort, PullRequest, RepoSlug } from "@titan-design/github";
import { BUMP_BRANCH_PREFIX, consumerBumpImplementer, titanDeps } from "./consumer-bump.js";
import { failureOf } from "./error-class.js";
import { ciRedFailing } from "./gates.js";
import type { Registration } from "./store.js";
import { HEAD_LINE, isSeat } from "./wake-brief.js";

/** Fixers Shepherd starts for one bump run; past them a red bump PR goes to its seat, as a run with no fixer does. */
export const BUMP_FIXER_ROUNDS = 3;
const MAX_BUMP_MANIFESTS = 20;

/** What a bump fixer's brief carries beyond a successor's: the bumped specifiers, and the seat its report goes to. */
export interface BumpFacts {
  bumped: string;
  seat: string | undefined;
}

/** A run the consumer bump sweep registered: its bump branch, and the implementer name only the sweep gives it. */
export function isConsumerBumpRun(registration: Registration): boolean {
  const { repo, pr, branch, implementer } = registration;
  return pr !== null && branch?.startsWith(BUMP_BRANCH_PREFIX) === true && implementer === consumerBumpImplementer(repo, pr);
}

/** A read that fails says so in the brief, so the wake still goes out. */
export async function bumpFacts(port: GitHubPort, registration: Registration, pr: PullRequest, number: number): Promise<BumpFacts> {
  const bumped = await bumpedSpecifiers(port, registration.repo, pr, number).catch((error: unknown) => `(the bumped specifiers could not be read: ${failureOf(error)})`);
  const { seat } = registration.policy;
  return { bumped, seat: seat !== "none" && isSeat(seat) ? seat : undefined };
}

async function bumpedSpecifiers(port: GitHubPort, repo: RepoSlug, pr: PullRequest, number: number): Promise<string> {
  const files = await port.listPrFiles(repo, number);
  const manifests = files.filter((file) => file.path.split("/").pop() === "package.json").slice(0, MAX_BUMP_MANIFESTS);
  const lines = (await Promise.all(manifests.map((file) => manifestBumps(port, repo, file.path, pr)))).flat();
  return lines.length > 0 ? lines.join("\n") : "No @titan-design specifier differs between the base and the head.";
}

async function manifestBumps(port: GitHubPort, repo: RepoSlug, path: string, pr: PullRequest): Promise<string[]> {
  const [base, head] = await Promise.all([port.getFile(repo, path, pr.baseRef), port.getFile(repo, path, pr.headSha)]);
  if (head === null) return [];
  const before = new Map(base === null ? [] : titanDeps(base));
  return titanDeps(head)
    .filter(([name, spec]) => before.get(name) !== spec)
    .map(([name, spec]) => `${name}: ${before.get(name) ?? "(not on the base)"} -> ${spec} (${path})`);
}

/** Why no further fixer starts, once the run's fixers reach the cap. */
export function bumpRoundsSpent(started: number): string | undefined {
  return started < BUMP_FIXER_ROUNDS ? undefined : `the consumer bump run has had its ${BUMP_FIXER_ROUNDS} fixers (${started} started), so its seat takes the red PR`;
}

/** The fix bump PRs need: the consumer follows the package's API, and a package regression is reported, never pinned around. */
const BUMP_RULE = [
  "Adapt this repo to the bumped packages' API changes: renamed exports and subpaths, newly required fields, changed return shapes, stale doc anchors and capture baselines.",
  "If a bumped package itself regressed, so that no consumer change is the right fix, report it and name the package and version; never pin a package back, or hold its specifier, to make CI pass.",
  "Push new commits with a plain `git push`; never force-push.",
  "Do not register with Shepherd: it started you and already tracks this PR.",
].join(" ");

interface BumpTask {
  input: { kind: string; repo: string; pr: number; payload: unknown };
  pr: PullRequest;
  reason: string;
  payload: string;
}

/** The sweep is no session, so the report goes to the seat that owns the repo, the one a run past its fixers wakes. */
function bumpReportLine(seat: string | undefined): string {
  if (seat === undefined) return "end your turn with your report as plain text and send it to no session, since this repo's seat is not a session name, and";
  return `send your report with chat_send to ${seat}, the seat that owns this repo, and to no other session. In it,`;
}

/** Check and package names are outside text, so each list stays in its own fence. */
export function bumpFixerBrief(task: BumpTask, facts: BumpFacts, name: string): string {
  const { input, pr } = task;
  const failing = ciRedFailing(input.kind, input.payload).map((check) => check.name);
  const checks = failing.length > 0 ? [dataFence("failing checks", failing.join("\n"))] : [];
  return [
    `You are ${name}, Shepherd's fixer for ${input.repo}#${input.pr}, a PR the factory's consumer bump sweep opened to raise this repo's @titan-design dependencies to npm latest. ${task.reason}`,
    `Your worktree is cut from the repo's main checkout, not from the PR. Before editing, fetch the PR's head branch, named in the fenced data below, and check it out at the PR head ${pr.headSha}. Commit on top of it and push to it. Do not open a new PR.\n\n${dataFence("head branch", pr.headRef)}`,
    `The bumped specifiers, base to head, follow.\n\n${dataFence("bumped packages", facts.bumped)}`,
    ...checks,
    task.payload,
    BUMP_RULE,
    `When pushed, ${bumpReportLine(facts.seat)} ${HEAD_LINE}`,
  ].join("\n\n");
}

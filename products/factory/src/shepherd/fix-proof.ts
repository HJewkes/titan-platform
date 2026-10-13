import { RESULT_PREFIX, parseResultLine, type FixProofResult } from "@titan-design/fix-proof";
import { GITHUB_ACTIONS_APP_ID, PR_FILES_CAP, type CheckRun, type GitHubPort, type PrFile, type RepoSlug } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { CHECKS_RECHECK_MS } from "../workflows/await-head.js";
import { deadline, type DeadlineTiming } from "../workflows/deadline.js";
import { codeRoute } from "../workflows/land.js";
import { failureOf } from "./error-class.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import type { Registration, ShepherdStoreRef } from "./store.js";

export const FIX_PROOF_STEP = "sh-fix-proof";
export const FIX_PROOF_STEPS: readonly StepDeclaration[] = [{ id: FIX_PROOF_STEP, kind: "dispatch" }];
export const FIX_PROOF_CHECK = "fix-proof";
/** The judge sits behind `needs:` on these jobs, so GitHub creates it only after both have finished. */
const FIX_PROOF_EXEC_CHECKS: ReadonlySet<string> = new Set(["fix-proof-base", "fix-proof-head"]);
/**
 * Above the three-job run's worst case: the 15-minute exec jobs, then the 8-minute judge created only after them, plus
 * queue gaps. A judge that runs to its limit is still read.
 */
const DEFAULT_FIX_PROOF_WAIT_MS = 35 * 60_000;
/**
 * A head that has no Actions run this long after the first poll never will: the repo runs no Actions on it, or the head opted out
 * with `[skip ci]`. In a repo whose base runs fix-proof, the grace ends in `error`, not `missing`.
 */
const DEFAULT_NO_ACTIONS_GRACE_MS = 3 * 60_000;
const LOG_TAIL_LINES = 200;
const GATED_KINDS: ReadonlySet<string> = new Set(["correctness", "security"]);
const FIX_BRANCH_PREFIX = "fix/";
const NO_REPRO_VERDICTS: ReadonlySet<string> = new Set(["vacuous", "no-tests"]);
const ACTIONS_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /;
/**
 * On `pull_request` the PR merge ref supplies the workflow file and the run script, so a PR touching any of these
 * chose the code that printed its own result line.
 */
const FIX_PROOF_HARNESS: readonly string[] = [".github/workflows/", ".github/actions/", ".github/fix-proof.json", "scripts/fix-proof-run.sh"];
/** Read at the PR's base ref, so a PR cannot delete its way out of the gate. */
const FIX_PROOF_WORKFLOW = ".github/workflows/fix-proof.yml";

type Parsed = { line: string; verdict: FixProofResult["verdict"] };
type FixProofRead = ({ kind: "result" } & Parsed) | ({ kind: "untrusted"; reason: string } & Parsed) | { kind: "skipped" | "missing" | "error"; reason: string };

/** The step output as replayed; only a `result` line is ever parsed again, so the rest is checked loosely. */
export const FixProofReadSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("result"), line: z.string(), verdict: z.string() }),
  z.looseObject({ kind: z.literal("untrusted"), line: z.string(), verdict: z.string(), reason: z.string() }),
  z.looseObject({ kind: z.enum(["skipped", "missing", "error"]), reason: z.string() }),
]);

const FixProofInputSchema = z.object({ repo: z.string().min(1), head: z.string().regex(/^[0-9a-f]{40}$/), runId: z.string().min(1) });
type FixProofInput = z.infer<typeof FixProofInputSchema>;

type PollTiming = Omit<DeadlineTiming, "timeoutMs"> & { timeoutMs?: number; pollMs?: number; noActionsGraceMs?: number };

type Gate = { open: true; pr: number | null } | { open: false; reason: string };

/** A store that cannot be read gives no kind, so the gate stays shut and the review proceeds with the reason recorded. */
async function gateOf(port: GitHubPort, store: ShepherdStoreRef, runId: string): Promise<Gate> {
  let registration: Registration | undefined;
  try {
    registration = store.get().byRun(runId);
  } catch (error) {
    return { open: false, reason: `the registered kind is unreadable: ${failureOf(error)}` };
  }
  if (registration === undefined) return { open: false, reason: "no registration for this run" };
  if (GATED_KINDS.has(registration.kind)) return { open: true, pr: registration.pr };
  const branch = await headBranchOf(port, registration);
  if (typeof branch !== "string") return { open: false, reason: branch.unreadable };
  // A branch only ever tightens the kind: a fix/ branch runs the gate whatever kind was registered.
  if (branch.startsWith(FIX_BRANCH_PREFIX)) return { open: true, pr: registration.pr };
  return { open: false, reason: `kind ${registration.kind}` };
}

/** A registration made by PR number stores no branch, so the PR itself names it. */
async function headBranchOf(port: GitHubPort, registration: Registration): Promise<string | { unreadable: string }> {
  if (registration.branch !== null) return registration.branch;
  if (registration.pr === null) return { unreadable: "head branch unreadable: the registration has neither a branch nor a pr" };
  try {
    return (await port.getPr(registration.repo, registration.pr)).headRef;
  } catch (error) {
    return { unreadable: `head branch unreadable: ${failureOf(error)}` };
  }
}

/** Only a run from GitHub Actions at this very head counts; a same-named check from any other app is ignored. */
const isFixProofRun = (head: string) => (run: CheckRun) => run.name === FIX_PROOF_CHECK && run.appId === GITHUB_ACTIONS_APP_ID && run.headSha === head;

const newestOf = (runs: readonly CheckRun[]): CheckRun | undefined =>
  runs.reduce<CheckRun | undefined>((newest, run) => (newest === undefined || run.id > newest.id ? run : newest), undefined);

/** The PR and base branch the registration names; a run is bound to it only if GitHub ties the run to that very pair. */
type Binding = { pr: number; baseRef: string } | { unbound: string };

async function bindingOf(port: GitHubPort, repo: RepoSlug, pr: number | null): Promise<Binding> {
  if (pr === null) return { unbound: "the registration names no PR, so no run can be bound to it" };
  try {
    return { pr, baseRef: (await port.getPr(repo, pr)).baseRef };
  } catch (error) {
    return { unbound: `the PR's base branch could not be read: ${failureOf(error)}` };
  }
}

const isBoundTo = (binding: Binding) => (run: CheckRun) => "pr" in binding && run.pullRequests.some((pr) => pr.number === binding.pr && pr.baseRef === binding.baseRef);

/**
 * Another PR opened from the same head sha onto a base of its own runs its own workflow file, whose run shares the name, app and head
 * sha. Exactly one run bound to this PR is trusted; none or several are not, and the newest is still read so the reason is reported.
 */
function chooseRun(candidates: readonly CheckRun[], binding: Binding): { run: CheckRun; distrust?: string } | undefined {
  const bound = candidates.filter(isBoundTo(binding));
  if (bound.length === 1) return { run: bound[0]! };
  const run = newestOf(candidates);
  if (run === undefined) return undefined;
  const why = "unbound" in binding ? binding.unbound : `${bound.length} ${FIX_PROOF_CHECK} runs at this head belong to PR #${binding.pr} on ${binding.baseRef}, not exactly one`;
  return { run, distrust: why };
}

const actionsAt = (runs: readonly CheckRun[], head: string): CheckRun[] => runs.filter((run) => run.appId === GITHUB_ACTIONS_APP_ID && run.headSha === head);

const execAt = (runs: readonly CheckRun[], head: string): boolean => actionsAt(runs, head).some((run) => FIX_PROOF_EXEC_CHECKS.has(run.name));

/**
 * Every Actions run at the head finished and none is fix-proof: the repo has no such job, or it was skipped. An exec job seen at
 * the head on any poll means the workflow runs here and its judge is still to be created, so its absence proves nothing.
 */
const settledWithout = (runs: readonly CheckRun[], head: string, execSeen: boolean): boolean => {
  const actions = actionsAt(runs, head);
  return actions.length > 0 && actions.every((run) => run.status === "completed") && !actions.some(isFixProofRun(head)) && !execSeen;
};

/**
 * `stalled` is a fix-proof run that existed at the head but never completed, or exec jobs that ran with no judge after them by the
 * deadline, so the absence of a line is not believed.
 */
type Polled = { run: CheckRun; distrust?: string } | { missing: string } | { stalled: string };

function deadlineRead(chosen: { run: CheckRun } | undefined, execSeen: boolean): Polled {
  if (chosen !== undefined) return { stalled: `the ${FIX_PROOF_CHECK} run at this head was still ${chosen.run.status} at the deadline` };
  if (execSeen) return { stalled: `the ${FIX_PROOF_CHECK} exec jobs ran at this head but no ${FIX_PROOF_CHECK} judge run completed before the deadline` };
  return { missing: `no completed ${FIX_PROOF_CHECK} check run from GitHub Actions at this head before the deadline` };
}

/** Absence is believed only on two polls in a row, since a job behind `needs:` is created after the runs it waits on finish. */
async function completedRun(port: GitHubPort, repo: RepoSlug, head: string, binding: Binding, timing: PollTiming, signal: AbortSignal): Promise<Polled> {
  const clock = deadline({ ...timing, timeoutMs: timing.timeoutMs ?? DEFAULT_FIX_PROOF_WAIT_MS });
  const grace = deadline({ ...timing, startedAt: undefined, timeoutMs: timing.noActionsGraceMs ?? DEFAULT_NO_ACTIONS_GRACE_MS });
  let settledBefore = false;
  let execSeen = false;
  for (;;) {
    const runs = await port.checkRuns(repo, head);
    const chosen = chooseRun(runs.filter(isFixProofRun(head)), binding);
    if (chosen?.run.status === "completed") return chosen;
    execSeen ||= execAt(runs, head);
    const settled = settledWithout(runs, head, execSeen);
    if (settled && settledBefore) return { missing: `every GitHub Actions run at this head completed with no ${FIX_PROOF_CHECK} check run` };
    if (actionsAt(runs, head).length === 0 && !execSeen && grace.expired()) return { missing: "no GitHub Actions run at this head" };
    if (clock.expired()) return deadlineRead(chosen, execSeen);
    settledBefore = settled;
    await clock.sleep(timing.pollMs ?? CHECKS_RECHECK_MS, signal);
  }
}

/** The last result line the parser accepts that names `head`; a line for any other head says nothing about this one. */
export function lastResultLine(log: string, head: string): string | undefined {
  const lines = log.split("\n").map((line) => line.replace(ACTIONS_TIMESTAMP, "").trimEnd());
  const naming = lines.filter((line) => {
    if (!line.startsWith(RESULT_PREFIX)) return false;
    const parsed = parseResultLine(line);
    return parsed.ok && parsed.result.head === head;
  });
  return naming.at(-1);
}

const inHarness = (path: string): boolean => FIX_PROOF_HARNESS.some((prefix) => path.startsWith(prefix));
const harnessPathOf = (files: readonly PrFile[]): string | undefined => files.flatMap((file) => [file.path, file.previousPath ?? file.path]).find(inHarness);

/** Why the PR may have chosen its own harness, or undefined when its changed files are read in full and leave the harness alone. */
async function harnessTouch(port: GitHubPort, repo: RepoSlug, pr: number | null): Promise<string | undefined> {
  if (pr === null) return "the registration names no PR, so its changed files are unknown";
  let files: PrFile[];
  try {
    files = await port.listPrFiles(repo, pr);
  } catch (error) {
    return `the PR's changed files could not be read: ${failureOf(error)}`;
  }
  if (files.length >= PR_FILES_CAP) return `the PR changes ${files.length} files, at GitHub's ${PR_FILES_CAP}-file list cap`;
  const touched = harnessPathOf(files);
  return touched && `the PR changes the ${FIX_PROOF_CHECK} harness: ${touched}`;
}

/** Why a line from `run` cannot be trusted, or undefined when the run succeeded on a harness the PR left alone. */
async function distrustOf(port: GitHubPort, repo: RepoSlug, pr: number | null, run: CheckRun): Promise<string | undefined> {
  if (run.conclusion !== "success") return `the ${FIX_PROOF_CHECK} run concluded ${run.conclusion ?? "nothing"}, not success`;
  return harnessTouch(port, repo, pr);
}

/**
 * Why the base ref may run fix-proof on this PR, or undefined only when the base is known to have no such workflow. A contents 404
 * also covers a base ref that does not exist, so a missing file is believed only once the branch itself is read.
 */
async function workflowAtBase(port: GitHubPort, repo: RepoSlug, binding: Binding): Promise<string | undefined> {
  if ("unbound" in binding) return binding.unbound;
  try {
    if ((await port.getFile(repo, FIX_PROOF_WORKFLOW, binding.baseRef)) !== null) return `${FIX_PROOF_WORKFLOW} exists at the base ${binding.baseRef}`;
    if ((await port.getHeadSha(repo, binding.baseRef)) === null) return `the base ${binding.baseRef} does not exist, so ${FIX_PROOF_WORKFLOW} could not be read there`;
    return undefined;
  } catch (error) {
    return `${FIX_PROOF_WORKFLOW} could not be read at the base ${binding.baseRef}: ${failureOf(error)}`;
  }
}

/**
 * A missing run is believed only when the PR left the harness alone and its base runs no fix-proof workflow. Otherwise deleting
 * the workflow, or a `[skip ci]` head that starts no Actions run, is a way to dodge the gate.
 */
async function missingRead(port: GitHubPort, repo: RepoSlug, pr: number | null, binding: Binding, missing: string): Promise<FixProofRead> {
  const touched = await harnessTouch(port, repo, pr);
  if (touched !== undefined) return { kind: "error", reason: `${missing}, and ${touched}` };
  const atBase = await workflowAtBase(port, repo, binding);
  return atBase === undefined ? { kind: "missing", reason: missing } : { kind: "error", reason: `${missing}, but ${atBase}` };
}

async function readResult(port: GitHubPort, input: FixProofInput, pr: number | null, timing: PollTiming, signal: AbortSignal): Promise<FixProofRead> {
  const binding = await bindingOf(port, input.repo, pr);
  const polled = await completedRun(port, input.repo, input.head, binding, timing, signal);
  if ("stalled" in polled) return { kind: "error", reason: polled.stalled };
  if ("missing" in polled) return missingRead(port, input.repo, pr, binding, polled.missing);
  const line = lastResultLine(await port.jobLogTail(input.repo, polled.run.id, LOG_TAIL_LINES), input.head);
  if (line === undefined) return { kind: "error", reason: `the ${FIX_PROOF_CHECK} job log has no result line for this head` };
  const parsed = parseResultLine(line);
  if (!parsed.ok) return { kind: "error", reason: parsed.error };
  const distrust = polled.distrust ?? (await distrustOf(port, input.repo, pr, polled.run));
  const verdict = parsed.result.verdict;
  return distrust === undefined ? { kind: "result", line, verdict } : { kind: "untrusted", line, verdict, reason: distrust };
}

/** The body of the sh-fix-proof step. A kind outside the gate makes no GitHub call; a read that fails is recorded and the review proceeds. */
export async function readFixProof(deps: Pick<ShepherdDeps, "port" | "store">, raw: unknown, timing: PollTiming, signal: AbortSignal): Promise<FixProofRead> {
  const input = FixProofInputSchema.parse(raw);
  const gate = await gateOf(deps.port, deps.store, input.runId);
  if (!gate.open) return { kind: "skipped", reason: gate.reason };
  try {
    return await readResult(deps.port, input, gate.pr, timing, signal);
  } catch (error) {
    signal.throwIfAborted();
    return { kind: "error", reason: `the ${FIX_PROOF_CHECK} check could not be read: ${failureOf(error)}` };
  }
}

export const fixProofRoute = (deps: ShepherdDeps): StepRoute =>
  codeRoute(FIX_PROOF_STEP, deps.now, (input: unknown, signal, clock) => readFixProof(deps, input, { now: deps.now, sleep: deps.sleep, pollMs: deps.pollMs, startedAt: clock.firstStartedAtMs }, signal));

/** A vacuous or test-less proof at `head` is NO_REPRO, carrying the parsed result; anything else lets the review proceed. */
export function fixProofVerdict(read: z.infer<typeof FixProofReadSchema>, head: string): Extract<Verdict, { kind: "NO_REPRO" }> | undefined {
  if (read.kind !== "result" || typeof read.line !== "string") return undefined;
  const parsed = parseResultLine(read.line);
  if (!parsed.ok || parsed.result.head !== head || !NO_REPRO_VERDICTS.has(parsed.result.verdict)) return undefined;
  return { kind: "NO_REPRO", headSha: head, result: parsed.result };
}

export type FixProofUnverified = "error" | "untrusted" | "unread";

/**
 * Why a gated proof that is not NO_REPRO still proves nothing about `head`, or undefined when it stands or no proof was expected.
 * A head can force each of these reads, so none may pass as if the bug were reproduced.
 */
export function fixProofStanding(read: z.infer<typeof FixProofReadSchema>, head: string): { unverified: FixProofUnverified } | undefined {
  if (read.kind === "untrusted") return { unverified: "untrusted" };
  if (read.kind === "error") return { unverified: "unread" };
  if (read.kind !== "result") return undefined;
  const parsed = typeof read.line === "string" ? parseResultLine(read.line) : undefined;
  if (!parsed?.ok || parsed.result.head !== head) return { unverified: "unread" };
  return parsed.result.verdict === "error" ? { unverified: "error" } : undefined;
}

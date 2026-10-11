import { RESULT_PREFIX, parseResultLine, type FixProofResult } from "@titan-design/fix-proof";
import { GITHUB_ACTIONS_APP_ID, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { deadline, type DeadlineTiming } from "../workflows/deadline.js";
import { codeRoute } from "../workflows/land.js";
import { failureOf } from "./error-class.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import type { ShepherdStoreRef } from "./store.js";

export const FIX_PROOF_STEP = "sh-fix-proof";
export const FIX_PROOF_STEPS: readonly StepDeclaration[] = [{ id: FIX_PROOF_STEP, kind: "dispatch" }];
export const FIX_PROOF_CHECK = "fix-proof";
/** Above the fix-proof job's own 20-minute timeout, so a job that runs to its limit is still read. */
const DEFAULT_FIX_PROOF_WAIT_MS = 25 * 60_000;
const DEFAULT_POLL_MS = 30_000;
const LOG_TAIL_LINES = 200;
const GATED_KINDS: ReadonlySet<string> = new Set(["correctness", "security"]);
const FIX_BRANCH_PREFIX = "fix/";
const NO_REPRO_VERDICTS: ReadonlySet<string> = new Set(["vacuous", "no-tests"]);
const ACTIONS_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /;

type FixProofRead = { kind: "result"; line: string; verdict: FixProofResult["verdict"] } | { kind: "skipped" | "missing" | "error"; reason: string };

/** The step output as replayed; only a `result` line is ever parsed again, so the rest is checked loosely. */
export const FixProofReadSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("result"), line: z.string(), verdict: z.string() }),
  z.looseObject({ kind: z.enum(["skipped", "missing", "error"]), reason: z.string() }),
]);

const FixProofInputSchema = z.object({ repo: z.string().min(1), head: z.string().regex(/^[0-9a-f]{40}$/), runId: z.string().min(1) });
type FixProofInput = z.infer<typeof FixProofInputSchema>;

type PollTiming = Omit<DeadlineTiming, "timeoutMs"> & { timeoutMs?: number; pollMs?: number };

/** A store that cannot be read gives no kind, so the gate stays shut and the review proceeds with the reason recorded. */
function gateOf(store: ShepherdStoreRef, runId: string): { open: true } | { open: false; reason: string } {
  try {
    const registration = store.get().byRun(runId);
    if (registration === undefined) return { open: false, reason: "no registration for this run" };
    if (GATED_KINDS.has(registration.kind)) return { open: true };
    // A branch only ever tightens the kind: a fix/ branch runs the gate whatever kind was registered.
    if (registration.branch?.startsWith(FIX_BRANCH_PREFIX)) return { open: true };
    return { open: false, reason: `kind ${registration.kind}` };
  } catch (error) {
    return { open: false, reason: `the registered kind is unreadable: ${failureOf(error)}` };
  }
}

/** Only a run from GitHub Actions at this very head counts; a same-named check from any other app is ignored. */
const isFixProofRun = (head: string) => (run: CheckRun) => run.name === FIX_PROOF_CHECK && run.appId === GITHUB_ACTIONS_APP_ID && run.headSha === head;

/** Every Actions run at the head finished and none is fix-proof: the repo has no such job, or it was skipped. */
const settledWithout = (runs: readonly CheckRun[], head: string): boolean => {
  const actions = runs.filter((run) => run.appId === GITHUB_ACTIONS_APP_ID && run.headSha === head);
  return actions.length > 0 && actions.every((run) => run.status === "completed") && !actions.some(isFixProofRun(head));
};

type Polled = { run: CheckRun } | { missing: string };

/** Absence is believed only on two polls in a row, since a job behind `needs:` is created after the runs it waits on finish. */
async function completedRun(port: GitHubPort, repo: RepoSlug, head: string, timing: PollTiming, signal: AbortSignal): Promise<Polled> {
  const clock = deadline({ ...timing, timeoutMs: timing.timeoutMs ?? DEFAULT_FIX_PROOF_WAIT_MS });
  let settledBefore = false;
  for (;;) {
    const runs = await port.checkRuns(repo, head);
    const run = runs.find(isFixProofRun(head));
    if (run?.status === "completed") return { run };
    const settled = settledWithout(runs, head);
    if (settled && settledBefore) return { missing: `every GitHub Actions run at this head completed with no ${FIX_PROOF_CHECK} check run` };
    if (clock.expired()) return { missing: `no completed ${FIX_PROOF_CHECK} check run from GitHub Actions at this head before the deadline` };
    settledBefore = settled;
    await clock.sleep(timing.pollMs ?? DEFAULT_POLL_MS, signal);
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

async function readResult(port: GitHubPort, input: FixProofInput, timing: PollTiming, signal: AbortSignal): Promise<FixProofRead> {
  const polled = await completedRun(port, input.repo, input.head, timing, signal);
  if ("missing" in polled) return { kind: "missing", reason: polled.missing };
  const line = lastResultLine(await port.jobLogTail(input.repo, polled.run.id, LOG_TAIL_LINES), input.head);
  if (line === undefined) return { kind: "missing", reason: `the ${FIX_PROOF_CHECK} job log has no result line for this head` };
  const parsed = parseResultLine(line);
  return parsed.ok ? { kind: "result", line, verdict: parsed.result.verdict } : { kind: "error", reason: parsed.error };
}

/** The body of the sh-fix-proof step. A kind outside the gate makes no GitHub call; a read that fails is recorded and the review proceeds. */
export async function readFixProof(deps: Pick<ShepherdDeps, "port" | "store">, raw: unknown, timing: PollTiming, signal: AbortSignal): Promise<FixProofRead> {
  const input = FixProofInputSchema.parse(raw);
  const gate = gateOf(deps.store, input.runId);
  if (!gate.open) return { kind: "skipped", reason: gate.reason };
  try {
    return await readResult(deps.port, input, timing, signal);
  } catch (error) {
    signal.throwIfAborted();
    return { kind: "error", reason: `the ${FIX_PROOF_CHECK} check could not be read: ${failureOf(error)}` };
  }
}

export const fixProofRoute = (deps: ShepherdDeps): StepRoute =>
  codeRoute(FIX_PROOF_STEP, deps.now, (input: unknown, signal) => readFixProof(deps, input, { now: deps.now, sleep: deps.sleep, pollMs: deps.pollMs }, signal));

/** A vacuous or test-less proof at `head` is NO_REPRO, carrying the parsed result; anything else lets the review proceed. */
export function fixProofVerdict(read: z.infer<typeof FixProofReadSchema>, head: string): Extract<Verdict, { kind: "NO_REPRO" }> | undefined {
  if (read.kind !== "result" || typeof read.line !== "string") return undefined;
  const parsed = parseResultLine(read.line);
  if (!parsed.ok || parsed.result.head !== head || !NO_REPRO_VERDICTS.has(parsed.result.verdict)) return undefined;
  return { kind: "NO_REPRO", headSha: head, result: parsed.result };
}

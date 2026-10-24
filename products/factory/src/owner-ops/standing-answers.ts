import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@titan-design/daemon";
import { MERGE_WAITS, type OwnerItemDeposit } from "@titan-design/owner-queue";
import { z } from "zod";
import { consoleResolver } from "../console-action/outcome.js";
import { MERGE_GATE, landGate, stepOf } from "../coordinator-evidence.js";
import type { FactoryHost, PendingGate } from "../host.js";
import { frozenFor } from "../shepherd/freeze.js";
import { LIVE, endRunsGoneElsewhere } from "../shepherd/gone-elsewhere.js";
import type { ShepherdServices } from "../shepherd/services.js";
import { startSweep, type Sweep } from "../sweep.js";
import { sweepLoopApproval, voidNotice, type LoopRead, type LoopResult } from "./loop-approval.js";

const STANDING_ANSWERS = "standing-answers.jsonl";
const STANDING_SWEEP_MS = 60_000;
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const StandingAnswerSchema = z.strictObject({
  actionId: z.string(),
  confirmEvent: z.string(),
  repo: z.string(),
  pr: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  /** The land-pr run whose approve-merge the answer resolves, or the Shepherd run whose pending gate it resolved at once. */
  runId: z.string(),
  /** Set only when the answer resolved this already-pending gate; the sweep never carries such an answer to a later gate. */
  gateId: z.string().optional(),
  expiresAt: z.iso.datetime(),
  /** Set when the owner approved a g10-held PR to merge only once its adversary loop closes MERGE; `runId` is then the Shepherd run. */
  waitFor: z.enum(MERGE_WAITS).optional(),
});
/** Appended when an approval stops standing; the answer's own line is never rewritten. */
const VoidSchema = z.strictObject({ actionId: z.string(), voided: z.string(), at: z.iso.datetime() });

/** An owner's merge-at-head tap, kept until the gate it answers opens at the head the owner confirmed. */
export type StandingAnswer = z.infer<typeof StandingAnswerSchema>;
/** An answer as listed: `voided` says why it no longer stands, once a void line names it. */
export type ListedAnswer = StandingAnswer & { voided?: string };

export interface StandingAnswers {
  add(answer: StandingAnswer): Promise<void>;
  list(): Promise<ListedAnswer[]>;
  voidAnswer(actionId: string, reason: string, at: Date): Promise<void>;
}

/** `<stateDir>/standing-answers.jsonl`; a line that does not parse is skipped, so one torn write never hides the rest. */
export function standingAnswers(stateDir: string): StandingAnswers {
  const path = join(stateDir, STANDING_ANSWERS);
  return {
    add: (answer) => appendLine(path, answer),
    voidAnswer: (actionId, voided, at) => appendLine(path, { actionId, voided, at: at.toISOString() }),
    async list() {
      const lines = (await readLines(path)).map(parseLine);
      const voids = new Map(lines.flatMap((line) => (line !== undefined && "voided" in line ? [[line.actionId, line.voided] as const] : [])));
      return lines.flatMap((line) => (line === undefined || "voided" in line ? [] : [voids.has(line.actionId) ? { ...line, voided: voids.get(line.actionId)! } : line]));
    },
  };
}

async function appendLine(path: string, line: object): Promise<void> {
  const handle = await open(path, APPEND_FLAGS, 0o600);
  try {
    await handle.write(`${JSON.stringify(line)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLines(path: string): Promise<string[]> {
  const handle = await open(path, READ_FLAGS).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (handle === undefined) return [];
  try {
    return (await handle.readFile("utf8")).split("\n");
  } finally {
    await handle.close();
  }
}

function parseLine(line: string): StandingAnswer | z.infer<typeof VoidSchema> | undefined {
  try {
    const json: unknown = JSON.parse(line);
    const answer = StandingAnswerSchema.safeParse(json);
    if (answer.success) return answer.data;
    const voided = VoidSchema.safeParse(json);
    return voided.success ? voided.data : undefined;
  } catch {
    return undefined;
  }
}

type StopReads = Pick<ShepherdServices, "store" | "freeze">;

/**
 * Why the owner's merge tap may not land `repo#pr` now: an owner-asked hold or a repo freeze. A g10 or other Shepherd hold
 * does not stop it (TP-3939 Q4 A): the owner saw it in the read-back. An unreadable freeze store counts as frozen.
 */
export function mergeStop({ store, freeze }: StopReads, repo: string, pr: number): string | undefined {
  const ownerHold = store.get().byPr(repo, pr)?.ownerHold;
  if (ownerHold) return `holds an owner-asked hold: ${ownerHold.reason}`;
  try {
    return freeze && frozenFor(freeze.get(), store.get(), repo, pr) ? "is in a frozen repo" : undefined;
  } catch {
    return "is in a repo whose freeze state could not be read";
  }
}

/** The run's approve-merge gates that are pending now, any iteration. */
export const pendingMergeGates = (host: Pick<FactoryHost, "pendingGates">, runId: string): PendingGate[] =>
  host.pendingGates().filter((pending) => pending.runId === runId && stepOf(pending.gate.id) === MERGE_GATE);

type StandingResult =
  | { kind: "resolved"; actionId: string; runId: string; gateId: string }
  | { kind: "pending"; actionId: string; runId: string; reason: string }
  | Exclude<LoopResult, { kind: "closed" }>;

/** Files the owner's notice for a voided approval; absent, the void is only logged and read back. */
export type TellOwner = (deposit: OwnerItemDeposit) => Promise<void>;

interface SweepOptions {
  tell?: TellOwner;
  loopRead?: LoopRead;
}

interface SweepDeps extends SweepOptions {
  host: FactoryHost;
  services: ShepherdServices;
  answers: StandingAnswers;
}

/**
 * One pass: each live answer resolves its land run's approve-merge only at the exact head the owner confirmed, only before it
 * expires, and only while no owner-asked hold or freeze stops the PR. Once that run completes, the PR's Shepherd run is ended
 * if GitHub shows the PR merged, so no seat has to resync it by hand. An approval that waits out a g10 hold goes to
 * `sweepLoopApproval` instead, and once its hold is gone it answers the Shepherd run's own approve-merge at the same head.
 */
export async function sweepStandingAnswers(host: FactoryHost, services: ShepherdServices, answers: StandingAnswers, now: Date, options: SweepOptions = {}): Promise<StandingResult[]> {
  const results: StandingResult[] = [];
  for (const answer of await answers.list()) {
    if (answer.gateId !== undefined || answer.voided !== undefined) continue;
    if (answer.waitFor !== undefined) {
      results.push(...(await loopApproval({ host, services, answers, ...options }, answer, now)));
      continue;
    }
    if (Date.parse(answer.expiresAt) > now.getTime()) results.push(...resolveAtHead(host, services, answer));
    await endShepherdRun(host, services, answer);
  }
  return results;
}

/** A void is written before the owner is told, so a failed notice never leaves the approval standing. */
async function loopApproval({ host, services, answers, tell, loopRead }: SweepDeps, answer: StandingAnswer, now: Date): Promise<StandingResult[]> {
  const result = await sweepLoopApproval(answer, { host, services, now, ...(loopRead && { loopRead }) });
  if (result === undefined) return [];
  if (result.kind === "closed") return resolveAtHead(host, services, answer);
  if (result.kind !== "voided") return [result];
  await answers.voidAnswer(answer.actionId, result.reason, now);
  const told = await tell?.(voidNotice(answer, result.reason)).then(
    () => undefined,
    (error: unknown) => `; the owner's notice could not be filed: ${error instanceof Error ? error.message : String(error)}`,
  );
  return [{ ...result, reason: `${result.reason}${told ?? ""}` }];
}

function resolveAtHead(host: FactoryHost, services: ShepherdServices, answer: StandingAnswer): StandingResult[] {
  const { actionId, runId } = answer;
  return pendingMergeGates(host, runId).map((pending): StandingResult => {
    const head = landGate(pending.gate)?.head;
    if (head !== answer.headSha) return { kind: "pending", actionId, runId, reason: `the gate asks about head ${head ?? "unknown"}, the owner confirmed ${answer.headSha}` };
    const stop = mergeStop(services, answer.repo, answer.pr);
    if (stop !== undefined) return { kind: "pending", actionId, runId, reason: `${answer.repo}#${answer.pr} ${stop}` };
    return signalled(host, answer, pending);
  });
}

/** A gate settled or refused meanwhile stays out of this answer's hands; the next answer in the pass still runs. */
function signalled(host: FactoryHost, { actionId, runId, headSha, confirmEvent }: StandingAnswer, pending: PendingGate): StandingResult {
  try {
    host.runtime.signal(runId, pending.stepId, { decision: "merge", headSha }, consoleResolver(confirmEvent));
    return { kind: "resolved", actionId, runId, gateId: pending.gate.id };
  } catch (error) {
    return { kind: "pending", actionId, runId, reason: `the gate refused the answer: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The merged-elsewhere sweep, limited to this PR's live Shepherd run; it reads GitHub, so a land that stopped short ends nothing. */
async function endShepherdRun(host: FactoryHost, services: ShepherdServices, answer: StandingAnswer): Promise<void> {
  if (host.runtime.status(answer.runId)?.status !== "completed") return;
  const shepherdRun = services.store.get().byPr(answer.repo, answer.pr)?.runId;
  if (shepherdRun === undefined || !LIVE.has(host.runtime.status(shepherdRun)?.status ?? "")) return;
  await endRunsGoneElsewhere(host, services, { scope: "live", only: new Set([shepherdRun]) });
}

interface SweepWhere {
  actionsDir: string | undefined;
  stateDir: string;
  now?: () => number;
  tell?: TellOwner;
}

const LOGGED: Partial<Record<StandingResult["kind"], string>> = {
  resolved: "answered an approve-merge gate from the owner's merge-at-head tap",
  released: "lifted a g10 hold on the owner's approval once the adversary loop closed MERGE at the approved head",
  voided: "voided the owner's merge approval and told the owner",
};

/** Runs only where serve answers console actions (`shepherd.consoleAnswers.actionsDir`); pending outcomes are not logged, since most wait on CI. */
export function startStandingAnswerSweep(host: FactoryHost, services: ShepherdServices | undefined, where: SweepWhere, log: Logger): Sweep | undefined {
  const { actionsDir, stateDir, now = Date.now, tell } = where;
  if (services === undefined || actionsDir === undefined) return undefined;
  const answers = standingAnswers(stateDir);
  const tick = async (): Promise<void> => {
    for (const result of await sweepStandingAnswers(host, services, answers, new Date(now()), { tell })) {
      const message = LOGGED[result.kind];
      if (message !== undefined) log.info({ ...result }, message);
    }
  };
  return startSweep(tick, STANDING_SWEEP_MS, "standing answer sweep", log);
}

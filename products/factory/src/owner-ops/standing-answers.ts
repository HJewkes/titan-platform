import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@titan-design/daemon";
import { z } from "zod";
import { consoleResolver } from "../console-action/outcome.js";
import { MERGE_GATE, landGate, stepOf } from "../coordinator-evidence.js";
import type { FactoryHost, PendingGate } from "../host.js";
import { frozenFor } from "../shepherd/freeze.js";
import { LIVE, endRunsGoneElsewhere } from "../shepherd/gone-elsewhere.js";
import type { ShepherdServices } from "../shepherd/services.js";
import { startSweep, type Sweep } from "../sweep.js";

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
});

/** An owner's merge-at-head tap, kept until the gate it answers opens at the head the owner confirmed. */
export type StandingAnswer = z.infer<typeof StandingAnswerSchema>;

export interface StandingAnswers {
  add(answer: StandingAnswer): Promise<void>;
  list(): Promise<StandingAnswer[]>;
}

/** `<stateDir>/standing-answers.jsonl`; a line that does not parse is skipped, so one torn write never hides the rest. */
export function standingAnswers(stateDir: string): StandingAnswers {
  const path = join(stateDir, STANDING_ANSWERS);
  return {
    async add(answer) {
      const handle = await open(path, APPEND_FLAGS, 0o600);
      try {
        await handle.write(`${JSON.stringify(answer)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async list() {
      const handle = await open(path, READ_FLAGS).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (handle === undefined) return [];
      try {
        return (await handle.readFile("utf8")).split("\n").flatMap(parseLine);
      } finally {
        await handle.close();
      }
    },
  };
}

function parseLine(line: string): StandingAnswer[] {
  try {
    const parsed = StandingAnswerSchema.safeParse(JSON.parse(line));
    return parsed.success ? [parsed.data] : [];
  } catch {
    return [];
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
  | { kind: "pending"; actionId: string; runId: string; reason: string };

/**
 * One pass: each live answer resolves its land run's approve-merge only at the exact head the owner confirmed, only before it
 * expires, and only while no owner-asked hold or freeze stops the PR. Once that run completes, the PR's Shepherd run is ended
 * if GitHub shows the PR merged, so no seat has to resync it by hand.
 */
export async function sweepStandingAnswers(host: FactoryHost, services: ShepherdServices, answers: StandingAnswers, now: Date): Promise<StandingResult[]> {
  const results: StandingResult[] = [];
  for (const answer of await answers.list()) {
    if (answer.gateId !== undefined) continue;
    if (Date.parse(answer.expiresAt) > now.getTime()) results.push(...resolveAtHead(host, services, answer));
    await endShepherdRun(host, services, answer);
  }
  return results;
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
}

/** Runs only where serve answers console actions (`shepherd.consoleAnswers.actionsDir`); pending outcomes are not logged, since most wait on CI. */
export function startStandingAnswerSweep(host: FactoryHost, services: ShepherdServices | undefined, where: SweepWhere, log: Logger): Sweep | undefined {
  const { actionsDir, stateDir, now = Date.now } = where;
  if (services === undefined || actionsDir === undefined) return undefined;
  const answers = standingAnswers(stateDir);
  const tick = async (): Promise<void> => {
    for (const result of await sweepStandingAnswers(host, services, answers, new Date(now()))) {
      if (result.kind === "resolved") log.info({ ...result }, "answered a land approve-merge gate from the owner's merge-at-head tap");
    }
  };
  return startSweep(tick, STANDING_SWEEP_MS, "standing answer sweep", log);
}

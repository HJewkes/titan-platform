import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@titan-design/daemon";
import type { GateResolver } from "@titan-design/hitl";
import type { WorkflowRun } from "@titan-design/workflow";
import type { FactoryHost, PendingGate } from "../host.js";
import { startSweep, type Sweep } from "../sweep.js";
import { RoundFeedbackSchema, SHIP_APPROVAL_MAX_AGE_MS, boundPrs, roundMergeDecisions } from "./round-merge.js";
import type { ShepherdServices } from "./services.js";

const ROUND_SHIP_SWEEP_MS = 60_000;
const MAX_ROUND_FILE_BYTES = 1024 * 1024;
/** O_NONBLOCK so a planted FIFO cannot hang the open; O_NOFOLLOW so a symlinked file is refused, not followed. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** One console round as the sweep reads it; `builtAtMs` is round.json's mtime, which the console writes once at import. */
export interface StoredRound {
  id: string;
  round: Uint8Array;
  /** Absent while the round is unanswered. */
  feedback: Uint8Array | undefined;
  builtAtMs: number;
}

type RoundShip =
  | { kind: "resolve"; roundId: string; runId: string; stepId: string; payload: { decision: "merge"; headSha: string }; confirmEvent: string }
  | { kind: "pending"; roundId: string; pr: string; reason: string };

/** The reason `repo#pr` may not merge at `headSha` now, as the merge guard reads it; undefined when nothing holds it there. */
export type HeldAt = (repo: string, pr: number, headSha: string) => string | undefined;

/**
 * Which open approve-merge gates the owner's console Ships answer (decisions item 97). Per PR only the round built last decides,
 * answered or not: a re-ask voids the answer before it (td#769 r2), so an earlier Ship never outlives a later Don't ship,
 * Send back, unanswered or withdrawn round. The answer then goes through `roundMergeDecisions`, so a Ship counts only at the
 * gate's exact head, only on a plain policy gate, and only within `SHIP_APPROVAL_MAX_AGE_MS`. A held PR is left pending.
 */
export function roundShips(rounds: readonly StoredRound[], gates: PendingGate[], runs: WorkflowRun[], now: Date, heldAt: HeldAt): RoundShip[] {
  const asked = new Set(gates.flatMap(({ stepId, gate }) => askedPr(stepId, gate.prompt) ?? []));
  return [...latestByPr(rounds)].flatMap(([pr, round]) => (asked.has(pr) ? shipFor(pr, round, gates, runs, now, heldAt) : []));
}

const GATE_TARGET = /^Merge PR #(\d+) in (\S+) at head /;

function askedPr(stepId: string, prompt: string): string | undefined {
  const match = stepId === "approve-merge" ? GATE_TARGET.exec(prompt) : null;
  return match ? `${match[2]}#${match[1]}` : undefined;
}

function latestByPr(rounds: readonly StoredRound[]): Map<string, StoredRound> {
  const latest = new Map<string, StoredRound>();
  for (const round of rounds) {
    for (const pr of boundPrs(round.round)) {
      const seen = latest.get(pr);
      if (!seen || round.builtAtMs > seen.builtAtMs || (round.builtAtMs === seen.builtAtMs && round.id > seen.id)) latest.set(pr, round);
    }
  }
  return latest;
}

function shipFor(pr: string, round: StoredRound, gates: PendingGate[], runs: WorkflowRun[], now: Date, heldAt: HeldAt): RoundShip[] {
  const pending = (reason: string): RoundShip[] => [{ kind: "pending", roundId: round.id, pr, reason }];
  if (round.feedback === undefined) return pending("the latest round for this PR is unanswered");
  const feedback = parseFeedback(round.feedback);
  if (!feedback) return pending("feedback.json does not read as round feedback");
  const { refused, decisions } = roundMergeDecisions(round.round, feedback, gates, runs, now, SHIP_APPROVAL_MAX_AGE_MS);
  const decision = decisions.find((each) => `${each.repo}#${each.pr}` === pr);
  if (refused !== undefined || decision === undefined) return pending(refused ?? "the round binds no question to this PR");
  if (decision.kind === "no-gate") return [];
  if (decision.kind === "pending") return pending(decision.reason);
  const held = heldAt(decision.repo, decision.pr, decision.headSha);
  if (held !== undefined) return pending(`held: ${held}`);
  const { runId, stepId, payload } = decision;
  return [{ kind: "resolve", roundId: round.id, runId, stepId, payload, confirmEvent: `round:${round.id}@${feedback.submittedAt}` }];
}

function parseFeedback(bytes: Uint8Array) {
  try {
    return RoundFeedbackSchema.safeParse(JSON.parse(Buffer.from(bytes).toString("utf8"))).data;
  } catch {
    return undefined;
  }
}

/** Every `<roundsDir>/<id>/round.json`, with its feedback.json when answered; a symlink, an oversize file or a read error skips the round. */
export async function readRounds(roundsDir: string): Promise<StoredRound[]> {
  const entries = await readdir(roundsDir, { withFileTypes: true });
  const rounds = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => readRound(join(roundsDir, entry.name), entry.name)));
  return rounds.filter((round) => round !== undefined);
}

async function readRound(dir: string, id: string): Promise<StoredRound | undefined> {
  const round = await readRegular(join(dir, "round.json"));
  if (round === undefined || round === "absent") return undefined;
  const feedback = await readRegular(join(dir, "feedback.json"));
  return feedback === undefined ? undefined : { id, round: round.bytes, feedback: feedback === "absent" ? undefined : feedback.bytes, builtAtMs: round.mtimeMs };
}

const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

/** `absent` only for a missing file; anything else unreadable is undefined, so the round is skipped rather than read as unanswered. */
async function readRegular(path: string): Promise<{ bytes: Uint8Array; mtimeMs: number } | "absent" | undefined> {
  const handle = await open(path, OPEN_FLAGS).catch((error: unknown) => (missing(error) ? ("absent" as const) : undefined));
  if (handle === undefined || handle === "absent") return handle;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_ROUND_FILE_BYTES) return undefined;
    return { bytes: await handle.readFile(), mtimeMs: stats.mtimeMs };
  } finally {
    await handle.close();
  }
}

/** The owner answered in the console; the round and its submit time name which answer, as the console's own Ship names its packet. */
const roundResolver = (confirmEvent: string): GateResolver => ({ class: "owner-remote", id: "titan-console", channel: "console:round-ship", confirmEvent });

type SweepHost = Pick<FactoryHost, "pendingGates"> & { runtime: Pick<FactoryHost["runtime"], "status" | "signal"> };

/** One pass: reads the rounds, answers each gate a Ship resolves if it is still pending, and returns what it decided. */
export async function sweepRoundShips(host: SweepHost, heldAt: HeldAt, roundsDir: string, now: Date): Promise<RoundShip[]> {
  const gates = host.pendingGates();
  if (gates.length === 0) return [];
  const runs = gates.flatMap(({ runId }) => host.runtime.status(runId) ?? []);
  const ships = roundShips(await readRounds(roundsDir), gates, runs, now, heldAt);
  for (const ship of ships) {
    const stillPending = ship.kind === "resolve" && host.pendingGates().some((pending) => pending.runId === ship.runId && pending.stepId === ship.stepId);
    if (stillPending) host.runtime.signal(ship.runId, ship.stepId, ship.payload, roundResolver(ship.confirmEvent));
  }
  return ships;
}

/** Runs only where serve answers console Ships (`shepherd.consoleAnswers`); pending outcomes are not logged, since most gates have no round. */
export function startRoundShipSweep(host: FactoryHost, services: ShepherdServices | undefined, roundsDir: string | undefined, log: Logger, now: () => number = Date.now): Sweep | undefined {
  if (services === undefined || roundsDir === undefined) return undefined;
  const heldAt: HeldAt = (repo, pr, headSha) => services.store.get().heldReason(repo, pr, undefined, headSha);
  const tick = async (): Promise<void> => {
    for (const ship of await sweepRoundShips(host, heldAt, roundsDir, new Date(now()))) {
      if (ship.kind === "resolve") log.info({ ...ship }, "answered an approve-merge gate from the owner's console Ship");
    }
  };
  return startSweep(tick, ROUND_SHIP_SWEEP_MS, "round ship sweep", log);
}

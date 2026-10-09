import { parseVerdictBlock } from "@titan-design/session-read";
import { deadline } from "../workflows/deadline.js";
import { bounded, type AwaitVerdictTiming } from "./await-verdict.js";
import { failureOf } from "./error-class.js";
import { fixFirstFindings } from "./fix-first-findings.js";
import type { AwaitVerdictResult, ReviewTarget, ReviewWiring, ReviewerAgent, ReviewerMessage, ReviewerReader } from "./review.js";
import type { Registration } from "./store.js";
import { namesTarget } from "./verdict-target.js";

/** The reviewer a hold waits on, from `hold --reviewer` alone; a name in the hold's reason text is never read as one. */
export function externalReviewer(registration: Registration | undefined): string | undefined {
  if (!registration?.held) return undefined;
  return registration.holdReviewer ?? undefined;
}

export interface ExternalVerdictInput {
  repo: string;
  pr: number;
  head: string;
  external: string;
}

export function isExternalVerdictInput(raw: unknown): raw is ExternalVerdictInput {
  return typeof raw === "object" && raw !== null && typeof (raw as { external?: unknown }).external === "string";
}

/** The newest message of the reviewer's latest session whose verdict block names this PR at this head; a WAIT there, or beside a MERGE of the same time, is no verdict. */
export function acceptExternalVerdict(input: ExternalVerdictInput, row: ReviewerAgent, messages: readonly ReviewerMessage[]): AwaitVerdictResult {
  const own = messages.filter((message) => message.agentId === row.agentId && message.sessionId === row.sessionId);
  const atHead = own.flatMap((message) => {
    const block = parseVerdictBlock(message.text);
    const named = "repo" in block && namesTarget(block, input);
    return named ? [{ message, block }] : [];
  });
  const merges = (entry: { block: { ok: boolean } }) => (entry.block.ok ? 1 : 0);
  const newest = atHead.sort((a, b) => b.message.writtenAt - a.message.writtenAt || merges(a) - merges(b))[0];
  if (!newest) return { kind: "none" };
  const { message, block } = newest;
  if (!block.ok) return { kind: "none", reason: "wait" };
  const accepted = { kind: "verdict" as const, head: block.head, locator: message.locator, reviewer: { agentId: row.agentId, sessionId: row.sessionId } };
  return block.verdict === "MERGE" ? { ...accepted, verdict: "MERGE" } : { ...accepted, verdict: "FIX_FIRST", text: fixFirstFindings(input, own, message.text), ...(block.closer && { closer: block.closer }) };
}

/** A name can span sessions; the last row the roster lists with a session holds it. */
export function latestSession(name: string, roster: readonly ReviewerAgent[]): ReviewerAgent | undefined {
  return roster.filter((agent) => agent.name === name && agent.sessionId !== "").at(-1);
}

/** Polls the hold's reviewer for a verdict at this head; Shepherd starts nobody, and the deadline ends the wait with `none`. */
export async function awaitExternalVerdict(roster: () => Promise<readonly ReviewerAgent[]>, reader: ReviewerReader, input: ExternalVerdictInput, timing: AwaitVerdictTiming, signal: AbortSignal): Promise<AwaitVerdictResult> {
  const clock = deadline(timing);
  for (;;) {
    const row = latestSession(input.external, await roster().catch(() => []));
    if (row) {
      const read = { repo: input.repo, pr: input.pr, head: input.head, reviewerAgentId: row.agentId, reviewerSessionId: row.sessionId, dispatchedAt: 0 };
      const result = acceptExternalVerdict(input, row, await reader.read(read).catch(() => []));
      if (result.kind === "verdict") return result;
    }
    if (clock.expired()) return { kind: "none" };
    await clock.sleep(timing.pollMs, signal);
  }
}

/** A seat's independent reviewer, as the seats name them; Shepherd's own reviewers are named `rv-*` and never match. */
export const SEAT_REVIEWER = /-review(-r[0-9]+)?$/;

interface AtHead {
  message: ReviewerMessage;
  verdict: "MERGE" | "FIX_FIRST" | "WAIT";
}

/** The newest verdict block naming this PR at this head; GitHub repo names ignore case, and on a tie in time a FIX_FIRST or WAIT beats a MERGE. */
export function newestAtHead(target: ReviewTarget, messages: readonly ReviewerMessage[]): AtHead | undefined {
  let newest: AtHead | undefined;
  for (const message of messages) {
    const block = parseVerdictBlock(message.text);
    const verdict = block.ok ? block.verdict : block.reason === "wait" ? "WAIT" : undefined;
    if (!verdict || !("repo" in block) || !Number.isFinite(message.writtenAt)) continue;
    if (!namesTarget(block, target)) continue;
    const later = !newest || message.writtenAt > newest.message.writtenAt || (message.writtenAt === newest.message.writtenAt && verdict !== "MERGE");
    if (later) newest = { message, verdict };
  }
  return newest;
}

/** A stopped reviewer's transcript that ends in a partial record; `readable` and `brief` are what its complete records said. */
export class DamagedTranscriptError extends Error {
  readonly readable: readonly ReviewerMessage[];
  readonly brief: string | null;

  constructor(message: string, readable: readonly ReviewerMessage[], brief: string | null = null) {
    super(message);
    this.name = "DamagedTranscriptError";
    this.readable = readable;
    this.brief = brief;
  }
}

/** One name's sessions, each read on its own: what every complete record said, and the reads that failed. */
interface NameRead {
  messages: readonly ReviewerMessage[];
  failures: readonly unknown[];
}

/** Every session the roster lists under one name; a message the reader attributes to any other session is dropped. A damaged session still gives its complete records. */
async function readReviewer(reader: ReviewerReader, target: ReviewTarget, rows: readonly ReviewerAgent[]): Promise<NameRead> {
  const read = async (row: ReviewerAgent) => {
    const input = { ...target, reviewerAgentId: row.agentId, reviewerSessionId: row.sessionId, dispatchedAt: 0 };
    return reader.readSeat ? reader.readSeat(input) : reader.read(input);
  };
  const owned = (message: ReviewerMessage) => rows.some((row) => row.agentId === message.agentId && row.sessionId === message.sessionId);
  const messages: ReviewerMessage[] = [];
  const failures: unknown[] = [];
  for (const outcome of await Promise.allSettled(rows.map(read))) {
    if (outcome.status === "fulfilled") messages.push(...outcome.value);
    else failures.push(outcome.reason);
    if (outcome.status === "rejected" && outcome.reason instanceof DamagedTranscriptError) messages.push(...outcome.reason.readable);
  }
  return { messages: messages.filter(owned), failures };
}

/** `clear` lets the MERGE stand; a FIX_FIRST sends the head back; a `none` with a reason is a read that failed, and blocks the head too. */
export type SeatCheck = Extract<AwaitVerdictResult, { verdict: "FIX_FIRST" }> | { kind: "none"; reason: string } | { kind: "clear" };

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `text` names this PR as `<owner>/<repo>#<n>` or `<repo>#<n>`, the repo in any letter case. */
function namesPr(target: ReviewTarget, text: string): boolean {
  const [owner = "", repo = ""] = target.repo.split("/");
  const pattern = new RegExp(`(?:^|[^\\w./-])(?:${escaped(owner)}/)?${escaped(repo)}#${target.pr}(?!\\d)`, "i");
  return pattern.test(text);
}

/** A brief naming this PR, or a verdict block naming it at any head, marks the reviewer as the PR's own. */
function reviewsThisPr(target: ReviewTarget, read: NameRead): boolean {
  const briefs = read.failures.flatMap((failure) => (failure instanceof DamagedTranscriptError && failure.brief !== null ? [failure.brief] : []));
  if (briefs.some((brief) => namesPr(target, brief))) return true;
  return read.messages.some((message) => {
    const block = parseVerdictBlock(message.text);
    return "repo" in block && block.repo.toLowerCase() === target.repo.toLowerCase() && block.pr === target.pr;
  });
}

/**
 * A damaged transcript blocks only the PR its brief or a verdict block ties it to; one tied to no PR, or only to
 * other PRs, warns instead of blocking every PR on the machine. Any other failure blocks.
 */
function failedRead(name: string, target: ReviewTarget, read: NameRead, warn: (line: string) => void): SeatCheck | undefined {
  const hard = read.failures.find((failure) => !(failure instanceof DamagedTranscriptError));
  const failure = hard ?? read.failures[0];
  if (failure === undefined) return undefined;
  if (hard === undefined && !reviewsThisPr(target, read)) {
    warn(`seat check: ${name} is not the reviewer of ${target.repo}#${target.pr}, so its damaged transcript does not block it: ${failureOf(failure)}`);
    return undefined;
  }
  return { kind: "none", reason: `seat check: the transcript of ${name} could not be read: ${failureOf(failure)}` };
}

function sentBack(name: string, target: ReviewTarget, message: ReviewerMessage, messages: readonly ReviewerMessage[]): SeatCheck {
  const text = fixFirstFindings(target, messages, message.text, `Seat reviewer ${name} said FIX_FIRST at this head.\n\n`);
  return { kind: "verdict", verdict: "FIX_FIRST", head: target.head, locator: message.locator, reviewer: { agentId: message.agentId, sessionId: message.sessionId }, text };
}

/**
 * Fails closed: an unreadable roster, or a seat reviewer's transcript that cannot be read or parsed, blocks the head. A
 * reviewer with no finished transcript yet reads as no verdict. Any FIX_FIRST is preferred over a failed read, since a fixer can act on it.
 */
export async function seatFixFirst(roster: () => Promise<readonly ReviewerAgent[]>, reader: ReviewerReader, target: ReviewTarget, warn: (line: string) => void = console.warn): Promise<SeatCheck> {
  let listed: readonly ReviewerAgent[];
  try {
    listed = await roster();
  } catch (error) {
    return { kind: "none", reason: `seat check: the roster could not be read: ${failureOf(error)}` };
  }
  const rows = listed.filter((row) => SEAT_REVIEWER.test(row.name) && row.sessionId !== "");
  let failed: SeatCheck | undefined;
  for (const name of new Set(rows.map((row) => row.name))) {
    const read = await readReviewer(reader, target, rows.filter((row) => row.name === name));
    const newest = newestAtHead(target, read.messages);
    if (newest?.verdict === "FIX_FIRST") return sentBack(name, target, newest.message, read.messages);
    if (newest?.verdict === "WAIT") return { kind: "none", reason: `seat check: ${name} said WAIT at ${target.head}, so its required checks had not finished` };
    failed ??= failedRead(name, target, read, warn);
  }
  return failed ?? { kind: "clear" };
}

/** A MERGE stands only while the seat check is clear at the same head. */
export async function unlessSeatFixFirst(roster: () => Promise<readonly ReviewerAgent[]>, reader: ReviewerReader, target: ReviewTarget, result: AwaitVerdictResult, warn?: (line: string) => void): Promise<AwaitVerdictResult> {
  if (result.kind !== "verdict" || result.verdict !== "MERGE") return result;
  const check = await seatFixFirst(roster, reader, target, warn);
  return check.kind === "clear" ? result : check;
}

type VerdictStep = (raw: unknown, signal: AbortSignal) => Promise<AwaitVerdictResult>;

/** Inside the step, so the replay reads the recorded outcome; with no dispatch wired there is no roster to read seat reviewers from. */
export function seatVetoed(wiring: ReviewWiring | undefined, body: VerdictStep): VerdictStep {
  return async (raw, signal) => {
    const result = await body(raw, signal);
    const dispatch = wiring?.dispatch;
    if (!dispatch) return result;
    const { repo, pr, head } = raw as ReviewTarget;
    return bounded(await unlessSeatFixFirst(() => dispatch.roster(), wiring.reader, { repo, pr, head }, result));
  };
}

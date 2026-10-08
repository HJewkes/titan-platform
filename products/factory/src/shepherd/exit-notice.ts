import type { AgentRow } from "@titan-design/agent-dispatch";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { failureOf } from "./error-class.js";
import type { GateRun } from "./gates.js";
import type { WakeEvidence, WakeRequest } from "./phases.js";
import { toPresence } from "./presence.js";
import { transcriptReviewerReader } from "./reviewer-reader.js";
import { lookupSeat, type SeatBook } from "./seats.js";

const EXIT_NOTICE_STEP = "sh-exit-notice";
export const EXIT_NOTICE_STEPS: readonly StepDeclaration[] = [{ id: EXIT_NOTICE_STEP, kind: "dispatch" }];

/** Long enough for a DONE report's status lines, short enough for one chat message. */
export const REPORT_MAX_CHARS = 600;

/** The last thing the exited agent wrote, from its transcript; `writtenAt` is epoch milliseconds. */
export interface LastReport {
  text: string;
  writtenAt: number;
}

/** What the notice reads and writes; absent from the deps means every exit takes the owner gate. */
export interface ExitNoticePorts {
  /** The agent-chat name of the one seat that owns `repo`, or undefined when no single seat does. */
  seatFor(repo: string): string | undefined;
  lastReport(target: { repo: string; pr: number; head: string }, agent: string, sessionId?: string): Promise<LastReport | undefined>;
  send(seat: string, text: string): Promise<void>;
}

/** `unread`: a live wake the agent exited before reading, because its last report predates the ask. `read-no-push`: it took the wake and pushed nothing. */
type ExitCause = "unread" | "read-no-push";

const ExitNoticeInput = z.object({
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  headSha: z.string().min(1),
  round: z.number().int().nonnegative(),
  kind: z.enum(["ci-red", "review", "conflict", "fix-proof"]),
  wake: z.object({ agent: z.string().min(1), sessionId: z.string().optional(), mode: z.enum(["resume", "successor", "live"]).optional(), askedAt: z.number().optional(), fallback: z.enum(["resume", "message"]).optional() }),
});
type ExitNoticeInput = z.infer<typeof ExitNoticeInput>;

const ExitNoticeResult = z.looseObject({ sent: z.boolean(), cause: z.enum(["unread", "read-no-push"]), detail: z.string(), seat: z.string().optional(), report: z.string().optional() });
type ExitNoticeResult = z.infer<typeof ExitNoticeResult>;

/**
 * A message to a live agent waits for its next turn, so an agent that ends the turn it was already in and exits never
 * reads it. A last report written after the ask shows a turn that could have; resume and successor wakes are the turn's prompt.
 */
export function exitCause(wake: WakeEvidence, report: LastReport | undefined): ExitCause {
  if (wake.mode !== "live") return "read-no-push";
  return report === undefined || wake.askedAt === undefined || report.writtenAt <= wake.askedAt ? "unread" : "read-no-push";
}

function causeText(cause: ExitCause, wake: WakeEvidence): string {
  if (cause === "unread") return `${wake.agent} was woken in live mode but wrote nothing after the wake, so it exited before reading the message`;
  return `${wake.agent} took the wake (mode ${wake.mode ?? "unrecorded"}) and wrote after it, but pushed nothing`;
}

const bounded = (text: string): string => (text.length > REPORT_MAX_CHARS ? `${text.slice(0, REPORT_MAX_CHARS - 1)}…` : text);

function wakeLine(wake: WakeEvidence): string {
  return `mode ${wake.mode ?? "unrecorded"}${wake.fallback === undefined ? "" : `, after a ${wake.fallback} fallback`}`;
}

/** The seat's one message: what happened, why, the agent's own last words, and what the seat can do next. */
export function noticeText(input: ExitNoticeInput, cause: ExitCause, report: LastReport | undefined): string {
  const { repo, pr, headSha, round, kind, wake } = input;
  return [
    `Shepherd: ${repo}#${pr} round ${round}: ${wake.agent} exited after the ${kind} wake (${wakeLine(wake)}) without pushing past head ${headSha}.`,
    `Why: ${causeText(cause, wake)}.`,
    report === undefined ? "Last report: none Shepherd could read." : `Last report (${new Date(report.writtenAt).toISOString()}):\n${bounded(report.text)}`,
    `The run waits for a new head, with no owner gate. Next: resume ${wake.agent} (\`agent-chat agent resume ${wake.agent}\`) or start a successor to push the fix, push a fix to the PR's branch yourself, or close the PR to end the run. A repeat \`shepherd register\` does not re-wake a live run.`,
  ].join("\n");
}

async function readReport(ports: ExitNoticePorts, input: ExitNoticeInput): Promise<LastReport | undefined> {
  return ports.lastReport({ repo: input.repo, pr: input.pr, head: input.headSha }, input.wake.agent, input.wake.sessionId).catch(() => undefined);
}

/** Never throws: no ports, no single seat, or a failed send records `sent: false`, and the run takes the owner gate. */
export async function sendExitNotice(ports: ExitNoticePorts | undefined, input: ExitNoticeInput): Promise<ExitNoticeResult> {
  const report = ports && (await readReport(ports, input));
  const cause = exitCause(input.wake, report);
  const recorded = { cause, ...(report && { report: bounded(report.text) }) };
  if (ports === undefined) return { sent: false, ...recorded, detail: "no seat notice is wired" };
  let seat: string | undefined;
  try {
    seat = ports.seatFor(input.repo);
    if (seat === undefined) return { sent: false, ...recorded, detail: `no single seat owns ${input.repo}` };
    await ports.send(seat, noticeText(input, cause, report));
    return { sent: true, seat, ...recorded, detail: causeText(cause, input.wake) };
  } catch (error) {
    return { sent: false, ...(seat && { seat }), ...recorded, detail: `the seat notice failed: ${failureOf(error)}` };
  }
}

export const exitNoticeRoute = (now: () => number, ports: ExitNoticePorts | undefined): StepRoute =>
  codeRoute(EXIT_NOTICE_STEP, now, async (raw: unknown) => sendExitNotice(ports, ExitNoticeInput.parse(raw)));

/** Heads a seat was told about, per run; a replay of the run's notice steps rebuilds the set. */
const noticedHeads = new WeakMap<object, Set<string>>();

/** Only the send-backs a fixer owns are the seat's to follow up; a conflict or fix-proof exit keeps the owner gate. */
const SEAT_KINDS: ReadonlySet<WakeRequest["kind"]> = new Set(["review", "ci-red"]);

type NoticeRun = GateRun & { state: { round: number } };

/**
 * A run recorded before this step went straight to the sent-back gate. Where the record continues, only a recorded
 * notice means noticing; where it ends, a run paused on `sh-sent-back` keeps its pending gate.
 */
function recordedWithoutNotice(run: NoticeRun): boolean {
  const next = run.ctx.historyNext();
  if (next !== undefined) return !stepIdMatches(EXIT_NOTICE_STEP, next);
  const paused = run.ctx.resumedGate();
  return paused !== undefined && stepIdMatches("sh-sent-back", paused);
}

/**
 * One seat message per run and head, recorded as a step so a restart replays it instead of sending again. Undefined
 * means the exit goes to the owner gate: a kind the seat does not follow, a second exit at a head already noticed, no
 * record of the wake, or a run whose record took the gate without a notice.
 */
export async function noticeSeat(run: NoticeRun, kind: WakeRequest["kind"], headSha: string, wake: WakeEvidence | undefined): Promise<ExitNoticeResult | undefined> {
  const noticed = noticedHeads.get(run.ctx) ?? noticedHeads.set(run.ctx, new Set()).get(run.ctx)!;
  if (!SEAT_KINDS.has(kind) || noticed.has(headSha) || wake === undefined || recordedWithoutNotice(run)) return undefined;
  const result = await step(run.ctx, EXIT_NOTICE_STEP, { ...run.target, headSha, round: run.state.round, kind, wake }, ExitNoticeResult);
  if (result.sent) noticed.add(headSha);
  return result;
}

/** A seat book entry that joins several seats names no one agent to message. */
function singleSeat(book: SeatBook, repo: string): string | undefined {
  const found = lookupSeat(book, repo);
  return found.kind === "seat" && !found.seat.name.includes("+") ? found.seat.name : undefined;
}

function latestSession(rows: readonly AgentRow[], agent: string, sessionId: string | undefined): AgentRow | undefined {
  const named = rows.filter((row) => row.name === agent && row.sessionId !== "" && (sessionId === undefined || row.sessionId === sessionId));
  return named.reduce<AgentRow | undefined>((best, row) => (best === undefined || row.generation >= best.generation ? row : best), undefined);
}

/** The agent's last message through the reviewer reader, which reads a seat's transcript whatever its presence. */
function transcriptLastReport(roster: () => Promise<readonly AgentRow[]>): ExitNoticePorts["lastReport"] {
  const reader = transcriptReviewerReader({ roster: async () => (await roster()).map((row) => ({ ...row, presence: toPresence(row.presence) })) });
  return async (target, agent, sessionId) => {
    const row = latestSession(await roster(), agent, sessionId);
    if (row === undefined || reader.readSeat === undefined) return undefined;
    const last = (await reader.readSeat({ ...target, reviewerAgentId: row.agentId, reviewerSessionId: row.sessionId, dispatchedAt: 0 })).at(-1);
    return last && { text: last.text, writtenAt: last.writtenAt };
  };
}

interface ExitNoticeAgents {
  roster(): Promise<readonly AgentRow[]>;
  message(name: string, message: string): Promise<void>;
}

/** The production ports: the seat book re-read per notice, the agent's transcript, and an agent-chat message to the seat. */
export function configuredExitNotice(seats: () => SeatBook, agents: ExitNoticeAgents): ExitNoticePorts {
  return {
    seatFor: (repo) => singleSeat(seats(), repo),
    lastReport: transcriptLastReport(() => agents.roster()),
    send: (seat, text) => agents.message(seat, text),
  };
}

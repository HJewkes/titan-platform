import { dataFence, type AgentRow } from "@titan-design/agent-dispatch";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { failureOf } from "./error-class.js";
import { registrantSeat, storedLineage } from "./registrant.js";
import type { GateRun } from "./gates.js";
import type { WakeEvidence, WakeRequest } from "./phases.js";
import { toPresence } from "./presence.js";
import { transcriptReviewerReader } from "./reviewer-reader.js";
import { lookupSeat, type SeatBook } from "./seats.js";
import type { ShepherdStoreRef } from "./store.js";
import { holdsLiveSession } from "./wake-roster.js";

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
  /** The config's shepherd.hubSeat, told about a held run whose policy names no seat; absent when none is set. */
  hubSeat?(): string | undefined;
  /** The seat the run's lineage names (`lineageSeat`); undefined, or absent, falls back to `seatFor`. */
  lineageSeat?(target: { repo: string; pr: number }): Promise<string | undefined>;
  lastReport(target: { repo: string; pr: number; head: string }, agent: string, sessionId?: string): Promise<LastReport | undefined>;
  send(seat: string, text: string): Promise<void>;
  /** Whether `seat` holds a live session; rejects when the roster cannot be read. Absent means every seat is taken as live. */
  live?(seat: string): Promise<boolean>;
  /** The seats a notice for `repo` goes to, in order, when its seat holds no live session. */
  fallbackSeats?(repo: string): readonly FallbackSeat[];
}

/** `from` names the config key the seat came from, so a rerouted notice's record says which one it reached. */
export interface FallbackSeat {
  seat: string;
  from: string;
}

/** Where a notice goes: the seat, the fallback that stands in for it with why, or why none can take it. */
type LiveRoute = { seat: string; rerouted?: string } | { none: string };

const liveOrUnread = (live: NonNullable<ExitNoticePorts["live"]>, seat: string): Promise<boolean> => live(seat).catch(() => true);

/**
 * A seat with no live session cannot take a message, as after its coordinator retired (tp#1859, #2177), so the first live
 * fallback takes the notice: the repo's red seat, the red seat fallback, then the hub seat. A roster that cannot be read
 * keeps the seat, as before liveness was checked.
 */
export async function liveRoute(ports: Pick<ExitNoticePorts, "live" | "fallbackSeats">, repo: string, seat: string): Promise<LiveRoute> {
  if (ports.live === undefined || (await liveOrUnread(ports.live, seat))) return { seat };
  for (const next of ports.fallbackSeats?.(repo) ?? []) {
    if (next.seat !== seat && (await liveOrUnread(ports.live, next.seat))) return { seat: next.seat, rerouted: `${seat} holds no live session, so ${next.from} ${next.seat} was told` };
  }
  return { none: `${seat} holds no live session and no fallback seat does` };
}

/** The detail a sent notice records: who was told, and why it was not the run's own seat. */
export const toldDetail = (route: { seat: string; rerouted?: string }, told: string): string => (route.rerouted === undefined ? told : `${told} (${route.rerouted})`);

/**
 * `unread`: a live wake the agent exited before reading, because its last report predates the ask. `read-no-push`: it
 * took the wake and pushed nothing. `held`: agent-chat refused to start the successor, so no agent took the wake.
 */
type ExitCause = "unread" | "read-no-push" | "held";

const ExitNoticeInput = z.object({
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  headSha: z.string().min(1),
  round: z.number().int().nonnegative(),
  kind: z.enum(["ci-red", "review", "conflict", "fix-proof"]),
  wake: z.object({ agent: z.string().min(1), sessionId: z.string().optional(), mode: z.enum(["resume", "successor", "live"]).optional(), askedAt: z.number().optional(), fallback: z.enum(["resume", "message"]).optional() }),
  /** Why a held wake's successor never started; the notice then reads no report, since no agent ran. */
  held: z.string().optional(),
  /** A held FIX_FIRST's findings, so the seat can start a fixer or fix it without the reviewer's transcript. */
  findings: z.string().optional(),
});
type ExitNoticeInput = z.infer<typeof ExitNoticeInput>;

const ExitNoticeResult = z.looseObject({ sent: z.boolean(), cause: z.enum(["unread", "read-no-push", "held"]), detail: z.string(), seat: z.string().optional(), report: z.string().optional() });
type ExitNoticeResult = z.infer<typeof ExitNoticeResult>;

/**
 * A message to a live agent waits for its next turn, so an agent that ends the turn it was already in and exits never
 * reads it. A last report written after the ask shows a turn that could have; resume and successor wakes are the turn's prompt.
 */
export function exitCause(wake: WakeEvidence, report: LastReport | undefined): ExitCause {
  if (wake.mode !== "live") return "read-no-push";
  return report === undefined || wake.askedAt === undefined || report.writtenAt <= wake.askedAt ? "unread" : "read-no-push";
}

function causeText(cause: ExitCause, wake: WakeEvidence, held?: string): string {
  if (cause === "held") return held ?? `agent-chat refused to start ${wake.agent}`;
  if (cause === "unread") return `${wake.agent} was woken in live mode but wrote nothing after the wake, so it exited before reading the message`;
  return `${wake.agent} took the wake (mode ${wake.mode ?? "unrecorded"}) and wrote after it, but pushed nothing`;
}

const bounded = (text: string): string => (text.length > REPORT_MAX_CHARS ? `${text.slice(0, REPORT_MAX_CHARS - 1)}…` : text);

function wakeLine(wake: WakeEvidence): string {
  return `mode ${wake.mode ?? "unrecorded"}${wake.fallback === undefined ? "" : `, after a ${wake.fallback} fallback`}`;
}

/** A transcript entry with no readable timestamp still gets its report sent; `toISOString` would throw on it. */
function writtenLine(report: LastReport): string {
  return Number.isFinite(report.writtenAt) ? `Last report (${new Date(report.writtenAt).toISOString()}):` : "Last report (time unrecorded):";
}

/**
 * The seat's one message: what happened, why, the agent's own last words, and what the seat can do next. The message
 * reaches the seat from the human seat, so the agent-written report is fenced as data; it may echo PR comments or CI text.
 */
export function noticeText(input: ExitNoticeInput, cause: ExitCause, report: LastReport | undefined): string {
  const { repo, pr, headSha, round, kind, wake } = input;
  if (cause === "held") return heldText(input);
  return [
    `Shepherd: ${repo}#${pr} round ${round}: ${wake.agent} exited after the ${kind} wake (${wakeLine(wake)}) without pushing past head ${headSha}.`,
    `Why: ${causeText(cause, wake)}.`,
    report === undefined ? "Last report: none Shepherd could read." : `${writtenLine(report)}\n${dataFence("last report", bounded(report.text))}`,
    `The run waits for a new head, with no owner gate. Next: resume ${wake.agent} (\`agent-chat agent resume ${wake.agent}\`) or start a successor to push the fix, push a fix to the PR's branch yourself, or close the PR to end the run. A repeat \`shepherd register\` does not re-wake a live run.`,
  ].join("\n");
}

/** A held wake started no agent, so the seat is told why and what it can start or push by hand. */
function heldText({ repo, pr, headSha, round, kind, wake, held, findings }: ExitNoticeInput): string {
  return [
    `Shepherd: ${repo}#${pr} round ${round}: no fixer took the ${kind} wake at head ${headSha}.`,
    `Why: ${causeText("held", wake, held)}.`,
    ...(findings === undefined ? [] : [`The reviewer's FIX_FIRST findings follow.\n${dataFence("review findings", findings)}`]),
    "The run waits for a new head, with no owner gate. Next: start a fixer on the PR's branch once agent-chat admits it, push a fix yourself, or close the PR to end the run.",
  ].join("\n");
}

async function readReport(ports: ExitNoticePorts, input: ExitNoticeInput): Promise<LastReport | undefined> {
  return ports.lastReport({ repo: input.repo, pr: input.pr, head: input.headSha }, input.wake.agent, input.wake.sessionId).catch(() => undefined);
}

/**
 * The run's lineage seat, else the repo's one seat. A notice lets the gate take its default action, which only a repo with
 * one seat authorises, so a denied, unseated or `+` joined repo names none and the owner gate opens whoever registered the
 * run. A lineage that cannot be read must not cost the notice.
 */
export async function runSeat(ports: ExitNoticePorts, target: { repo: string; pr: number }): Promise<string | undefined> {
  const seat = ports.seatFor(target.repo);
  if (seat === undefined) return undefined;
  return (await ports.lineageSeat?.(target).catch(() => undefined)) ?? seat;
}

/** Never throws: no ports, no single seat, or a failed send records `sent: false`, and the run takes the owner gate. */
export async function sendExitNotice(ports: ExitNoticePorts | undefined, input: ExitNoticeInput): Promise<ExitNoticeResult> {
  const report = ports && input.held === undefined ? await readReport(ports, input) : undefined;
  const cause = input.held === undefined ? exitCause(input.wake, report) : "held";
  const recorded = { cause, ...(report && { report: bounded(report.text) }) };
  if (ports === undefined) return { sent: false, ...recorded, detail: "no seat notice is wired" };
  let seat: string | undefined;
  try {
    seat = await runSeat(ports, input);
    if (seat === undefined) return { sent: false, ...recorded, detail: `no single seat owns ${input.repo}` };
    const route = await liveRoute(ports, input.repo, seat);
    if ("none" in route) return { sent: false, seat, ...recorded, detail: route.none };
    seat = route.seat;
    await ports.send(seat, noticeText(input, cause, report));
    return { sent: true, seat, ...recorded, detail: toldDetail(route, causeText(cause, input.wake, input.held)) };
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

/** Why a held wake's successor never started, and the FIX_FIRST findings it would have been handed. */
export interface HeldNotice {
  reason: string;
  findings?: string;
}

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
export async function noticeSeat(run: NoticeRun, kind: WakeRequest["kind"], headSha: string, wake: WakeEvidence | undefined, held?: HeldNotice): Promise<ExitNoticeResult | undefined> {
  const noticed = noticedHeads.get(run.ctx) ?? noticedHeads.set(run.ctx, new Set()).get(run.ctx)!;
  if (!SEAT_KINDS.has(kind) || noticed.has(headSha) || wake === undefined || recordedWithoutNotice(run)) return undefined;
  const heldFields = { ...(held !== undefined && { held: held.reason }), ...(held?.findings !== undefined && { findings: held.findings }) };
  const result = await step(run.ctx, EXIT_NOTICE_STEP, { ...run.target, headSha, round: run.state.round, kind, wake, ...heldFields }, ExitNoticeResult);
  if (result.sent) noticed.add(headSha);
  return result;
}

/** A seat book entry that joins several seats names no one agent to message. */
export function singleSeat(book: SeatBook, repo: string): string | undefined {
  const found = lookupSeat(book, repo);
  return found.kind === "seat" && !found.seat.name.includes("+") ? found.seat.name : undefined;
}

function latestSession(rows: readonly AgentRow[], agent: string, sessionId: string | undefined): AgentRow | undefined {
  const named = rows.filter((row) => row.name === agent && row.sessionId !== "" && (sessionId === undefined || row.sessionId === sessionId));
  return named.reduce<AgentRow | undefined>((best, row) => (best === undefined || row.generation >= best.generation ? row : best), undefined);
}

/** The agent's last message through the reviewer reader, which reads a seat's transcript whatever its presence. */
function transcriptLastReport(roster: () => Promise<readonly AgentRow[]>): ExitNoticePorts["lastReport"] {
  const reader = transcriptReviewerReader({ roster: async () => (await roster()).map((row) => ({ ...row, presence: toPresence(row.presence), transcriptPath: row.transcriptPath ?? null, transcriptExists: row.transcriptExists === true })) });
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

/** The roster is read only for a run that names a registrant, which is named only while live. */
function lineagePort(agents: ExitNoticeAgents, store: ShepherdStoreRef): ExitNoticePorts["lineageSeat"] {
  return async (target) => {
    const lineage = storedLineage(store, target);
    return lineage && registrantSeat(lineage, lineage.registrant ? await agents.roster() : undefined);
  };
}

/** The config's shepherd.hubSeat and shepherd.redSeat, the seats that stand in for a seat with no live session. */
export interface NoticeFallbacks {
  hubSeat?: string;
  redSeat?: { repos?: Record<string, string>; fallback?: string };
}

/** The repo's red seat entry (keys match in any case, as for red events), the red seat fallback, then the hub seat. */
export function fallbackSeats({ hubSeat, redSeat }: NoticeFallbacks, repo: string): FallbackSeat[] {
  const entry = Object.entries(redSeat?.repos ?? {}).find(([key]) => key.toLowerCase() === repo.toLowerCase())?.[1];
  const candidates = [
    { seat: entry, from: "shepherd.redSeat.repos" },
    { seat: redSeat?.fallback, from: "shepherd.redSeat.fallback" },
    { seat: hubSeat, from: "shepherd.hubSeat" },
  ];
  return candidates.flatMap(({ seat, from }) => (seat === undefined ? [] : [{ seat, from }]));
}

/**
 * The production ports: the run's lineage seat, else the seat book re-read per notice, checked live on the roster with the
 * config's fallbacks behind it, the hub seat, the agent's transcript, and an agent-chat message to the seat.
 */
export function configuredExitNotice(seats: () => SeatBook, agents: ExitNoticeAgents, fallbacks: NoticeFallbacks = {}, store?: ShepherdStoreRef): ExitNoticePorts {
  return {
    seatFor: (repo) => singleSeat(seats(), repo),
    ...(store && { lineageSeat: lineagePort(agents, store) }),
    hubSeat: () => fallbacks.hubSeat,
    lastReport: transcriptLastReport(() => agents.roster()),
    send: (seat, text) => agents.message(seat, text),
    live: async (seat) => holdsLiveSession(seat, await agents.roster()),
    fallbackSeats: (repo) => fallbackSeats(fallbacks, repo),
  };
}

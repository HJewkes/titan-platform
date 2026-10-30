/**
 * `inbox.list`: the owner's one inbox, read only. It takes `approvals.flow`'s merged order, joins each factory gate to its
 * live Shepherd row by run id, and gives every item the one action a tap would take, or the terminal command and why the
 * console offers none. A write action's target comes from a system of record, never from a deposit: a hitl gate joined to a
 * live row that is not replay-diverged, or a deposit's typed `op`. A deposit is agent-written, so its op only
 * names the target: a gate or hold op maps onto that live row's own action, and an op on `CONSOLE_OPS` becomes `owner-op`,
 * whose read-back `inbox.prepare` takes from the factory's preview. Nothing here writes.
 */
import { z } from "zod";
import type { OwnerItem, OwnerOp, OwnerOpKind } from "@titan-design/owner-queue";
import { readRoster, type AgentsSource } from "./agents.js";
import { readFlow, type ApprovalsSources } from "./approvals.js";
import { gateStripCommands, gateStripReader, holdClassOf, type GateStrip, type GateStripReader } from "./gate-strip.js";
import type { AgentRosterSnapshot } from "@titan-design/chat-protocol/agents";
import { foldCoveredGates, gateHeadOf, liveAgentNames, markAged, onePerPr, oneRowPerRound, pinOf, sectionOf, type InboxSection, type Placed } from "./inbox-blocking.js";
import { blockedAgentRows, byDerivedOrder, failedRunRows, stalledRunRows, type DerivedRow } from "./inbox-derived.js";
import { readCommand } from "./owner-guard.js";
import { missedNoticeRows } from "./round-notice-gaps.js";
import { roundNudges, type RoundNudge } from "./round-nudge.js";
import { readQueueRounds } from "./rounds.js";
import type { ShepherdSource } from "./shepherd.js";
import { UNWIRED_LINEAGE, type LineageReader, type ShipLineage } from "./ship-lineage.js";
import { inboxReadCache, viewRows, type InboxReadCache, type ViewRows } from "./inbox-rows.js";

export type WatchRow = Awaited<ReturnType<ShepherdSource["list"]>>[number];

type InboxAction =
  | { kind: "resolve-gate"; gateId: string; runId: string; stepId: string; repo: string; pr: number; headSha: string; decision: ConsoleDecision; alternatives?: ConsoleDecision[] }
  | { kind: "owner-release"; repo: string; pr: number; headSha: string }
  | { kind: "hold-release"; repo: string; pr: number; headSha: string; holdClass: string }
  | { kind: "owner-op"; op: OwnerOp }
  | { kind: "answer-chat"; msgId: string }
  | { kind: "approve-chat"; msgId: string }
  | { kind: "open-round"; roundId: string }
  | { kind: "open"; route: string }
  | { kind: "terminal"; command?: string; reason: string };

export interface InboxItem extends OwnerItem {
  section: InboxSection;
  hold?: { class: string; reason: string };
  action: InboxAction;
  /** A held gate's own action, taken once the hold is released. */
  then?: InboxAction;
  /** Every other gate on the item's PR at its live head; only a hitl item joined to a pinned live row has one. */
  gates?: GateStrip;
  /** Where a resolve-gate item's PR head stands against its base; the round page's cached read, so a row adds no read of its own. */
  lineage?: ShipLineage;
  evidence: string | undefined;
  /** Set on a round's one row when it asks more than one question; the round page holds them. */
  questionCount?: number;
  /** The gates a round's row stands for: each at the PR head one of its merge-bound questions pins. */
  foldedGates?: string[];
  /** A blocking item open past four days: listed under "Older than 4 days", still blocking. */
  aged?: true;
}

interface InboxList {
  items: InboxItem[];
  gaps: string[];
  fyiCount: number;
  readAt: string;
}

/**
 * `inbox.list`'s answer: the owner queue as rows the page renders, planning rows only when asked for, the machine-derived
 * rows that carry no action, and the rounds waiting over six hours.
 */
export interface InboxView extends Omit<InboxList, "items">, ViewRows {
  derived: DerivedRow[];
  nudges: RoundNudge[];
}

export interface InboxSources extends ApprovalsSources {
  shepherd: ShepherdSource;
  /** Optional so test sources need not build one; absent, the inbox derives no blocked-agent rows. */
  agents?: AgentsSource;
  now?: () => number;
}

/**
 * The gate steps the console taps and the decisions each may give, as data the factory's `CONSOLE_STEPS` mirrors and
 * re-checks against the gate's own schema. The first is the item's tap; the rest are second taps offered only where the
 * gate's options list them. An sh-sent-back gate waits for the implementer's next pushed head (TP-3949), or on a fix-proof
 * send-back waives the fix-proof at this head (TP-3626); neither merges nor abandons anything.
 */
const CONSOLE_DECISIONS = { "approve-merge": ["merge"], "sh-sent-back": ["await-new-head", "waive-proof"] } as const satisfies Record<string, readonly string[]>;
type ConsoleStep = keyof typeof CONSOLE_DECISIONS;
export type ConsoleDecision = (typeof CONSOLE_DECISIONS)[ConsoleStep][number];
export const CONSOLE_DECISION_IDS: readonly [ConsoleDecision, ...ConsoleDecision[]] = ["merge", "await-new-head", "waive-proof"];
/** The factory route refuses these to an owner-remote resolver (`batchRefusal`, `DEVICE_RULE`), so the console offers no tap. */
const HARDWARE_STEP = /device|hardware/;
const AFTER_STAGES_STEP = "after-stages";
const OWNER_HOLD_CLASS = "owner-asked";
/** The op kinds a deposit may hand the factory as an `owner-op` tap, as data: each kind joins once its factory effect lands. */
const CONSOLE_OPS: ReadonlySet<OwnerOpKind> = new Set(["merge-at-head", "retire-agent", "close-pr", "deploy-pause-clear"]);
/**
 * TP-3918: a gate on a replay-diverged run is consumed with no merge. A row-joined diverged run says so in its stall
 * reason. A rowless gate may be a land run's or one a diverged run left behind when it was replaced, and the item cannot
 * tell which, so every rowless gate is held to the Morning path until TP-3918 lands.
 */
export const DIVERGED_HOLD = "resolve from Morning (TP-3918)";
const REPLAY_DIVERGED = /^replay diverged/;

/** Gate ids are `<runId>/<stepId>` or `<runId>/<stepId>:<n>`. */
function gateParts(gateId: string): { runId: string; stepId: string } | undefined {
  const slash = gateId.indexOf("/");
  if (slash === -1) return undefined;
  const step = gateId.slice(slash + 1);
  const repeat = step.lastIndexOf(":");
  return { runId: gateId.slice(0, slash), stepId: repeat === -1 ? step : step.slice(0, repeat) };
}

const terminal = (reason: string, command?: string): InboxAction => ({ kind: "terminal", reason, ...(command !== undefined && { command }) });

const timelineRoute = (row: WatchRow): string => `#/shepherd/${encodeURIComponent(`${row.repo}#${row.pr}`)}`;

const releaseCommand = (row: WatchRow, holdClass: string): string =>
  holdClass === OWNER_HOLD_CLASS
    ? `titan-factory shepherd owner-release ${row.repo}#${row.pr} --head ${row.headSha}`
    : `titan-factory shepherd release ${row.repo}#${row.pr} --head ${row.headSha} --class ${holdClass}`;

const isConsoleStep = (stepId: string): stepId is ConsoleStep => Object.hasOwn(CONSOLE_DECISIONS, stepId);

/**
 * The step's decisions the gate offers, the item's own tap first, or none when the gate lacks that one. An item with options
 * lists exactly the gate's schema. One with none (a gate of several questions) gets the first alone and leaves the check to
 * the factory, so a second tap such as a waiver is offered only where the gate itself lists it.
 */
function offeredDecisions(item: OwnerItem, stepId: ConsoleStep): ConsoleDecision[] {
  const [first, ...rest]: readonly ConsoleDecision[] = CONSOLE_DECISIONS[stepId];
  const { options } = item;
  if (options === undefined) return [first];
  const offered = (decision: ConsoleDecision) => options.some((option) => option.id === decision);
  return offered(first) ? [first, ...rest.filter(offered)] : [];
}

function gateStepDecisions(item: OwnerItem, stepId: string): ConsoleDecision[] | InboxAction {
  const { command } = item;
  if (HARDWARE_STEP.test(stepId)) return terminal("a device or hardware gate answers only at the device's own terminal", command);
  if (stepId === AFTER_STAGES_STEP) return terminal("an after-stages gate deploys or publishes after the merge; the factory refuses it to the console", command);
  if (!isConsoleStep(stepId)) return terminal(`the console answers approve-merge and sh-sent-back gates; ${stepId} is answered with its command`, command);
  const offered = offeredDecisions(item, stepId);
  return offered.length > 0 ? offered : terminal(`this ${stepId} gate offers no ${CONSOLE_DECISIONS[stepId][0]}; answer it with its command`, command);
}

const isDiverged = (row: WatchRow | undefined): boolean => row === undefined || REPLAY_DIVERGED.test(row.stalled?.reason ?? "");

function gateAction(item: OwnerItem, gateId: string, row: WatchRow | undefined): InboxAction {
  const parts = gateParts(gateId);
  if (parts === undefined) return terminal("the gate names no run, so the console cannot read its PR back", item.command);
  const decisions = gateStepDecisions(item, parts.stepId);
  if (!Array.isArray(decisions)) return decisions;
  if (isDiverged(row)) return terminal(DIVERGED_HOLD, item.command);
  if (row!.pr === null || row!.headSha === null) return terminal("no live Shepherd row pins this gate's PR and head", item.command);
  const [decision, ...alternatives] = decisions;
  return { kind: "resolve-gate", gateId, runId: parts.runId, stepId: parts.stepId, repo: row!.repo, pr: row!.pr, headSha: row!.headSha, decision: decision!, ...(alternatives.length > 0 && { alternatives }) };
}

function holdAction(row: WatchRow, holdClass: string | undefined): InboxAction {
  if (holdClass === undefined) return terminal("the hold's reason names no class, so the console cannot name the hold to release");
  if (row.pr === null || row.headSha === null) return terminal("the held run has no PR head to release at", releaseCommand(row, holdClass));
  const at = { repo: row.repo, pr: row.pr, headSha: row.headSha };
  return holdClass === OWNER_HOLD_CLASS ? { kind: "owner-release", ...at } : { kind: "hold-release", ...at, holdClass };
}

type Derived = Pick<InboxItem, "action" | "then" | "hold">;

/** A held gate's tap releases the hold first; the gate's own action follows as `then`. */
function hitlDerived(item: OwnerItem, gateId: string, row: WatchRow | undefined): Derived {
  const gate = gateAction(item, gateId, row);
  if (row?.held == null) return { action: gate };
  const holdClass = holdClassOf(row.held.reason);
  return { action: holdAction(row, holdClass), then: gate, hold: { class: holdClass ?? "unclassed", reason: row.held.reason } };
}

const openOrTerminal = (evidence: string | undefined, item: OwnerItem, reason: string): InboxAction =>
  evidence === undefined ? terminal(reason, item.command) : { kind: "open", route: evidence };

/** A hold op is only a pointer: the release, its class and its head all come from the live row, and a mismatch offers nothing. */
function holdOpAction(item: OwnerItem, op: Extract<OwnerOp, { kind: "release-hold" }>, row: WatchRow | undefined): InboxAction {
  if (row?.held == null) return terminal(`no live Shepherd row holds ${op.repo}#${op.pr}`, item.command);
  const holdClass = holdClassOf(row.held.reason);
  if (holdClass !== op.holdClass) return terminal(`${op.repo}#${op.pr} is held as ${holdClass ?? "unclassed"}, not ${op.holdClass}`, item.command);
  return holdAction(row, holdClass);
}

/** A merge-at-head on a held PR shows the hold, so the page can offer a g10 hold's second tap: approve now, merge once the loop closes. */
function mergeHold(op: OwnerOp, row: WatchRow | undefined): Pick<Derived, "hold"> {
  if (op.kind !== "merge-at-head" || row?.held == null) return {};
  return { hold: { class: holdClassOf(row.held.reason) ?? "unclassed", reason: row.held.reason } };
}

const short = (sha: string): string => sha.slice(0, 8);

/**
 * TP-4402: a gate op offers the gate's own tap only while that gate is still the row's open one at the head the deposit
 * named, so a tap never approves a head the deposit's ask did not cover. Its command pins the same head, so neither
 * fallback shows it.
 */
function gateOpDerived(item: OwnerItem, op: Extract<OwnerOp, { kind: "resolve-gate" }>, row: WatchRow | undefined): Derived {
  if (row !== undefined && row.pendingGate?.gateId.toLowerCase() !== op.gateId.toLowerCase()) {
    return { action: terminal(`gate ${op.gateId} is no longer open on ${row.repo}#${row.pr ?? "?"}; withdraw this deposit`) };
  }
  if (row?.headSha != null && row.headSha.toLowerCase() !== op.headSha.toLowerCase()) {
    return { action: terminal(`this deposit asks at ${short(op.headSha)}, but the gate now pins ${short(row.headSha)}; answer the gate's own item at that head`) };
  }
  return hitlDerived(item, op.gateId, row);
}

/** A deposit's op names a target; the action comes from the live row, or for an allowlisted kind from the factory's preview at the tap. */
function depositDerived(item: OwnerItem, row: WatchRow | undefined): Derived {
  const { op } = item;
  if (op === undefined) return { action: terminal("a deposit is agent-written, so the console offers it no write; run its command", item.command) };
  if (op.kind === "resolve-gate") return gateOpDerived(item, op, row);
  if (op.kind === "release-hold") return { action: holdOpAction(item, op, row) };
  if (CONSOLE_OPS.has(op.kind)) return { action: { kind: "owner-op", op }, ...mergeHold(op, row) };
  return { action: terminal(`a ${op.kind} op has no console tap yet; run its command`, item.command) };
}

/** The pure item-to-action mapping: `row` is the live Shepherd row of the item's run, when it has one. */
export function actionFor(item: OwnerItem, row: WatchRow | undefined, evidence: string | undefined = evidenceOf(item, row)): Derived {
  const source = item.sources[0]!;
  switch (source.system) {
    case "hitl":
      return hitlDerived(item, source.ref, row);
    case "agent-chat":
      return { action: { kind: item.kind === "approve" ? "approve-chat" : "answer-chat", msgId: source.ref } };
    case "round":
      return { action: { kind: "open-round", roundId: roundIdOf(source.ref) } };
    case "deposit":
      return depositDerived(item, row);
    default:
      return { action: openOrTerminal(evidence, item, `answered at its source, ${source.system}`) };
  }
}

const roundIdOf = (ref: string): string => (ref.includes("#") ? ref.slice(0, ref.indexOf("#")) : ref);

/** An active-work ref is `<slug>/<task id>`; the console's task route names the task id. */
const taskRoute = (ref: string): string => `#/tasks/${encodeURIComponent(ref.slice(ref.lastIndexOf("/") + 1))}`;

function evidenceOf(item: OwnerItem, row: WatchRow | undefined): string | undefined {
  const source = item.sources[0]!;
  if (source.system === "hitl" && row?.held != null && row.pr !== null) return timelineRoute(row);
  const named = item.evidenceRef ?? item.shown?.[0];
  if (named !== undefined) return named;
  if (source.system === "round") return `#/rounds/${encodeURIComponent(roundIdOf(source.ref))}`;
  if (source.system === "active-work") return taskRoute(source.ref);
  return undefined;
}

const rowOfRun = (gateId: string, rows: ReadonlyMap<string, WatchRow>): WatchRow | undefined => {
  const runId = gateParts(gateId)?.runId;
  return runId === undefined ? undefined : rows.get(runId.toLowerCase());
};

const rowOfPr = (repo: string, pr: number, rows: ReadonlyMap<string, WatchRow>): WatchRow | undefined =>
  [...rows.values()].find((row) => row.repo.toLowerCase() === repo.toLowerCase() && row.pr === pr);

function rowOfItem(item: OwnerItem, rows: ReadonlyMap<string, WatchRow>): WatchRow | undefined {
  const source = item.sources[0]!;
  if (source.system === "hitl") return rowOfRun(source.ref, rows);
  if (source.system !== "deposit" || item.op === undefined) return undefined;
  if (item.op.kind === "resolve-gate") return rowOfRun(item.op.gateId, rows);
  return item.op.kind === "release-hold" || item.op.kind === "merge-at-head" ? rowOfPr(item.op.repo, item.op.pr, rows) : undefined;
}

interface ItemFacts {
  strips?: ReadonlyMap<string, GateStrip>;
  /** Absent means the roster was not read, so no deposit or chat asker counts as live. */
  liveAgents?: ReadonlySet<string>;
  now?: number;
}

interface Joins {
  rows: ReadonlyMap<string, WatchRow>;
  strips: ReadonlyMap<string, GateStrip>;
  liveAgents: ReadonlySet<string> | undefined;
  now: number;
}

function inboxItem(item: OwnerItem, { rows, strips, liveAgents, now }: Joins): Placed<InboxItem> {
  const row = rowOfItem(item, rows);
  const evidence = evidenceOf(item, row);
  const gates = row === undefined ? undefined : strips.get(row.runId);
  const placed = { ...item, section: sectionOf(item, { row, liveAgents, now }), ...actionFor(item, row, evidence), evidence, ...(gates !== undefined && { gates }) };
  const head = gateHeadOf(item, row);
  return { item: placed, pin: pinOf(item, row), ...(head !== undefined && { head }) };
}

/** Blocking before planning, newest first inside each; the id breaks a tie so a poll never reshuffles. */
function byInboxOrder(a: InboxItem, b: InboxItem): number {
  if (a.section !== b.section) return a.section === "blocking" ? -1 : 1;
  const opened = Date.parse(b.openedAt) - Date.parse(a.openedAt);
  return opened !== 0 ? opened : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const byRunId = (rows: readonly WatchRow[]): Map<string, WatchRow> => new Map(rows.map((row) => [row.runId.toLowerCase(), row]));

export function inboxItems(order: readonly OwnerItem[], rows: readonly WatchRow[], { strips = new Map(), liveAgents, now = Date.now() }: ItemFacts = {}): InboxItem[] {
  const joins = { rows: byRunId(rows), strips, liveAgents, now };
  return markAged(oneRowPerRound(onePerPr(foldCoveredGates(order.map((item) => inboxItem(item, joins))))), now).sort(byInboxOrder);
}

/** Unwired or unread, a merge gate still carries a lineage, so its row says "lineage unknown" rather than showing nothing. */
async function withLineage(items: InboxItem[], read: LineageReader | undefined): Promise<InboxItem[]> {
  return Promise.all(
    items.map(async (item) => {
      const { action } = item;
      if (action.kind !== "resolve-gate" || action.decision !== "merge") return item;
      const lineage = read === undefined ? UNWIRED_LINEAGE : await read({ repo: action.repo, pr: action.pr, headSha: action.headSha });
      return { ...item, lineage };
    }),
  );
}

/** Only the rows a hitl item joins get a strip, so a run nobody is asked about costs no reads. */
function joinedRows(order: readonly OwnerItem[], rows: readonly WatchRow[]): WatchRow[] {
  const byRun = byRunId(rows);
  return [...new Set(order.flatMap((item) => rowOfItem(item, byRun) ?? []))];
}

interface Read<T> {
  value: T;
  gaps: string[];
}

async function readOrGap<T>(label: string, read: () => Promise<T>, fallback: T): Promise<Read<T>> {
  try {
    return { value: await read(), gaps: [] };
  } catch (error) {
    return { value: fallback, gaps: [`${label}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

type RosterRead = Read<AgentRosterSnapshot | undefined> | undefined;

interface OwnerQueueRead {
  list: InboxList;
  live: Read<WatchRow[]>;
  roster: RosterRead;
}

/** The roster names the live askers a deposit or chat item waits on; unread, every such item reads as non-blocking. */
async function readOwnerQueue({ shepherd, agents, now = Date.now, ...sources }: InboxSources, strips?: GateStripReader): Promise<OwnerQueueRead> {
  const [approvals, live, roster] = await Promise.all([
    readFlow(sources),
    readOrGap("shepherd", () => shepherd.list("active"), []),
    agents === undefined ? undefined : readOrGap("agents", () => readRoster(agents), undefined),
  ]);
  const order = approvals.flow.order;
  const gates = strips === undefined ? new Map<string, GateStrip>() : await strips.readMany(joinedRows(order, live.value));
  const liveAgents = roster?.value === undefined ? undefined : liveAgentNames(roster.value);
  const items = await withLineage(inboxItems(order, live.value, { strips: gates, liveAgents, now: now() }), sources.rounds.lineage);
  return { list: { items, gaps: [...approvals.gaps, ...live.gaps], fyiCount: approvals.fyiCount, readAt: approvals.readAt }, live, roster };
}

export async function readInbox(sources: InboxSources): Promise<InboxList> {
  return (await readOwnerQueue(sources)).list;
}

const NOT_READ: Read<WatchRow[]> = { value: [], gaps: [] };

/** A Shepherd that just failed the active read already has its gap line, so the finished read is dropped, not doubled. */
async function readDerived({ rounds, now = Date.now }: InboxSources, { live, roster }: Omit<OwnerQueueRead, "list">, finishedRead: Promise<Read<WatchRow[]>>): Promise<Read<DerivedRow[]>> {
  const at = now();
  const [read, missed] = await Promise.all([finishedRead, readOrGap("round notices", () => missedNoticeRows(rounds.dir, at), [])]);
  const finished = live.gaps.length > 0 ? NOT_READ : read;
  const blocked = roster?.value === undefined ? [] : blockedAgentRows(roster.value);
  const rows = [...stalledRunRows(live.value, at), ...failedRunRows(finished.value, live.value, at), ...blocked, ...missed.value].sort(byDerivedOrder);
  return { value: rows, gaps: [...finished.gaps, ...(roster?.gaps ?? []), ...missed.gaps] };
}

/** The queue read already reports an unreadable round as a gap, so a nudge read adds none of its own. */
async function readNudges({ rounds, now = Date.now }: InboxSources): Promise<RoundNudge[]> {
  const read = await readQueueRounds(rounds);
  return roundNudges(rounds.dir, read.rounds, now()).catch(() => []);
}

/** The finished runs are read beside the queue rather than after it, since each read waits seconds on its upstream. */
async function readInboxView(sources: InboxSources, strips: GateStripReader, cache: InboxReadCache, args: { planning?: boolean }): Promise<InboxView> {
  const finished = readOrGap("shepherd finished", () => cache.finished.read(), []);
  const [{ list, ...reads }, nudges] = await Promise.all([readOwnerQueue({ ...sources, factory: cache.factory }, strips), readNudges(sources)]);
  const derived = await readDerived(sources, reads, finished);
  const { items, ...rest } = list;
  return { ...rest, ...viewRows(items, args), gaps: [...list.gaps, ...derived.gaps], derived: derived.value, nudges };
}

export function inboxViewCommands(sources: InboxSources, cache: InboxReadCache = inboxReadCache(sources)) {
  const strips = gateStripReader(sources.shepherd, sources.now);
  return {
    ...gateStripCommands(sources.shepherd, strips),
    "inbox.list": readCommand({
      name: "inbox.list",
      description:
        "The owner's inbox: approvals.flow joined to Shepherd's live rows, each item with the one action a tap takes or the terminal command and, for a gate on a live PR, its gate strip at that head; blocking first and newest first, planning items counted and listed only with planning; beside them, machine-derived stall, failed-run, blocked-agent and missed round-notice rows with their evidence and no action; and each round open over six hours, once, with its recommendations stated",
      args: z.object({ planning: z.boolean().optional().describe("list the planning items too; left out unless true") }),
      result: z.custom<InboxView>(),
      run: (args) => readInboxView(sources, strips, cache, args),
    }),
  };
}

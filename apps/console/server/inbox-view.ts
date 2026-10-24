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
import { blockedAgentRows, byDerivedOrder, failedRunRows, stalledRunRows, type DerivedRow } from "./inbox-derived.js";
import { readCommand } from "./owner-guard.js";
import { roundNudges, type RoundNudge } from "./round-nudge.js";
import { readQueueRounds } from "./rounds.js";
import type { ShepherdSource } from "./shepherd.js";

export type WatchRow = Awaited<ReturnType<ShepherdSource["list"]>>[number];

type InboxAction =
  | { kind: "resolve-gate"; gateId: string; runId: string; stepId: string; repo: string; pr: number; headSha: string; decision: ConsoleDecision }
  | { kind: "owner-release"; repo: string; pr: number; headSha: string }
  | { kind: "hold-release"; repo: string; pr: number; headSha: string; holdClass: string }
  | { kind: "owner-op"; op: OwnerOp }
  | { kind: "answer-chat"; msgId: string }
  | { kind: "open-round"; roundId: string }
  | { kind: "open"; route: string }
  | { kind: "terminal"; command?: string; reason: string };

type InboxSection = "blocking" | "planning";

export interface InboxItem extends OwnerItem {
  section: InboxSection;
  hold?: { class: string; reason: string };
  action: InboxAction;
  /** A held gate's own action, taken once the hold is released. */
  then?: InboxAction;
  evidence: string | undefined;
}

interface InboxList {
  items: InboxItem[];
  gaps: string[];
  fyiCount: number;
  readAt: string;
}

/** `inbox.list`'s answer: the owner queue, the machine-derived rows that carry no action, and the rounds waiting over six hours. */
export interface InboxView extends InboxList {
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
 * The gate steps the console taps and the one decision each tap gives, as data the factory's `CONSOLE_STEPS` mirrors and
 * re-checks against the gate's own schema. An sh-sent-back tap only waits for the implementer's next pushed head; it merges
 * nothing and abandons nothing (TP-3949). TP-3620 T1 adds `waive-proof` here.
 */
const CONSOLE_DECISIONS = { "approve-merge": ["merge"], "sh-sent-back": ["await-new-head"] } as const satisfies Record<string, readonly string[]>;
type ConsoleStep = keyof typeof CONSOLE_DECISIONS;
export type ConsoleDecision = (typeof CONSOLE_DECISIONS)[ConsoleStep][number];
/** The factory route refuses these to an owner-remote resolver (`batchRefusal`, `DEVICE_RULE`), so the console offers no tap. */
const HARDWARE_STEP = /device|hardware/;
const AFTER_STAGES_STEP = "after-stages";
const OWNER_HOLD_CLASS = "owner-asked";
/** The op kinds a deposit may hand the factory as an `owner-op` tap, as data: each kind joins once its factory effect lands. */
const CONSOLE_OPS: ReadonlySet<OwnerOpKind> = new Set(["merge-at-head", "close-pr"]);
/**
 * TP-3918: a gate on a replay-diverged run is consumed with no merge. A row-joined diverged run says so in its stall
 * reason. A rowless gate may be a land run's or one a diverged run left behind when it was replaced, and the item cannot
 * tell which, so every rowless gate is held to the Morning path until TP-3918 lands.
 */
export const DIVERGED_HOLD = "resolve from Morning (TP-3918)";
const REPLAY_DIVERGED = /^replay diverged/;

/** Read as Shepherd's `holdClassOf` reads it: the text before the first colon, untrimmed. */
export const holdClassOf = (reason: string): string | undefined => (reason.includes(":") ? reason.slice(0, reason.indexOf(":")) : undefined);

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
 * The step's decision, when the gate offers it: an item with options lists exactly the gate's schema, and one with none
 * (a gate of several questions) leaves the check to the factory, which reads the schema itself.
 */
function offeredDecision(item: OwnerItem, stepId: ConsoleStep): ConsoleDecision | undefined {
  return CONSOLE_DECISIONS[stepId].find((decision) => item.options?.some((option) => option.id === decision) ?? true);
}

function gateStepDecision(item: OwnerItem, stepId: string): ConsoleDecision | InboxAction {
  const { command } = item;
  if (HARDWARE_STEP.test(stepId)) return terminal("a device or hardware gate answers only at the device's own terminal", command);
  if (stepId === AFTER_STAGES_STEP) return terminal("an after-stages gate deploys or publishes after the merge; the factory refuses it to the console", command);
  if (!isConsoleStep(stepId)) return terminal(`the console answers approve-merge and sh-sent-back gates; ${stepId} is answered with its command`, command);
  return offeredDecision(item, stepId) ?? terminal(`this ${stepId} gate offers no ${CONSOLE_DECISIONS[stepId].join(" or ")}; answer it with its command`, command);
}

const isDiverged = (row: WatchRow | undefined): boolean => row === undefined || REPLAY_DIVERGED.test(row.stalled?.reason ?? "");

function gateAction(item: OwnerItem, gateId: string, row: WatchRow | undefined): InboxAction {
  const parts = gateParts(gateId);
  if (parts === undefined) return terminal("the gate names no run, so the console cannot read its PR back", item.command);
  const decision = gateStepDecision(item, parts.stepId);
  if (typeof decision !== "string") return decision;
  if (isDiverged(row)) return terminal(DIVERGED_HOLD, item.command);
  if (row!.pr === null || row!.headSha === null) return terminal("no live Shepherd row pins this gate's PR and head", item.command);
  return { kind: "resolve-gate", gateId, runId: parts.runId, stepId: parts.stepId, repo: row!.repo, pr: row!.pr, headSha: row!.headSha, decision };
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

/** A deposit's op names a target; the action comes from the live row, or for an allowlisted kind from the factory's preview at the tap. */
function depositDerived(item: OwnerItem, row: WatchRow | undefined): Derived {
  const { op } = item;
  if (op === undefined) return { action: terminal("a deposit is agent-written, so the console offers it no write; run its command", item.command) };
  if (op.kind === "resolve-gate") return hitlDerived(item, op.gateId, row);
  if (op.kind === "release-hold") return { action: holdOpAction(item, op, row) };
  if (CONSOLE_OPS.has(op.kind)) return { action: { kind: "owner-op", op } };
  return { action: terminal(`a ${op.kind} op has no console tap yet; run its command`, item.command) };
}

/** The pure item-to-action mapping: `row` is the live Shepherd row of the item's run, when it has one. */
export function actionFor(item: OwnerItem, row: WatchRow | undefined, evidence: string | undefined = evidenceOf(item, row)): Derived {
  const source = item.sources[0]!;
  switch (source.system) {
    case "hitl":
      return hitlDerived(item, source.ref, row);
    case "agent-chat":
      return { action: item.kind === "approve" ? terminal("an agent's approval or permission prompt is answered at its own session; the broker never approves over HTTP", item.command) : { kind: "answer-chat", msgId: source.ref } };
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

const sectionOf = (item: OwnerItem): InboxSection => (item.lens.startsWith("blocking-") || item.lens === "stuck" ? "blocking" : "planning");

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
  return item.op.kind === "release-hold" ? rowOfPr(item.op.repo, item.op.pr, rows) : undefined;
}

function inboxItem(item: OwnerItem, rows: ReadonlyMap<string, WatchRow>): InboxItem {
  const row = rowOfItem(item, rows);
  const evidence = evidenceOf(item, row);
  return { ...item, section: sectionOf(item), ...actionFor(item, row, evidence), evidence };
}

/** Blocking before planning, newest first inside each; the id breaks a tie so a poll never reshuffles. */
function byInboxOrder(a: InboxItem, b: InboxItem): number {
  if (a.section !== b.section) return a.section === "blocking" ? -1 : 1;
  const opened = Date.parse(b.openedAt) - Date.parse(a.openedAt);
  return opened !== 0 ? opened : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function inboxItems(order: readonly OwnerItem[], rows: readonly WatchRow[]): InboxItem[] {
  const byRun = new Map(rows.map((row) => [row.runId.toLowerCase(), row]));
  return order.map((item) => inboxItem(item, byRun)).sort(byInboxOrder);
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

async function readOwnerQueue({ shepherd, ...sources }: InboxSources): Promise<{ list: InboxList; live: Read<WatchRow[]> }> {
  const [approvals, live] = await Promise.all([readFlow(sources), readOrGap("shepherd", () => shepherd.list("active"), [])]);
  const list = { items: inboxItems(approvals.flow.order, live.value), gaps: [...approvals.gaps, ...live.gaps], fyiCount: approvals.fyiCount, readAt: approvals.readAt };
  return { list, live };
}

export async function readInbox(sources: InboxSources): Promise<InboxList> {
  return (await readOwnerQueue(sources)).list;
}

const NOT_READ: Read<WatchRow[]> = { value: [], gaps: [] };

/** A Shepherd that just failed the active read already has its gap line, so the finished read is skipped, not doubled. */
async function readDerived({ shepherd, agents, now = Date.now }: InboxSources, live: Read<WatchRow[]>): Promise<Read<DerivedRow[]>> {
  const [finished, roster] = await Promise.all([
    live.gaps.length > 0 ? NOT_READ : readOrGap("shepherd finished", () => shepherd.list("finished"), []),
    agents === undefined ? undefined : readOrGap("agents", () => readRoster(agents), undefined),
  ]);
  const at = now();
  const blocked = roster?.value === undefined ? [] : blockedAgentRows(roster.value);
  const rows = [...stalledRunRows(live.value, at), ...failedRunRows(finished.value, live.value, at), ...blocked].sort(byDerivedOrder);
  return { value: rows, gaps: [...finished.gaps, ...(roster?.gaps ?? [])] };
}

/** The queue read already reports an unreadable round as a gap, so a nudge read adds none of its own. */
async function readNudges({ rounds, now = Date.now }: InboxSources): Promise<RoundNudge[]> {
  const read = await readQueueRounds(rounds);
  return roundNudges(rounds.dir, read.rounds, now()).catch(() => []);
}

async function readInboxView(sources: InboxSources): Promise<InboxView> {
  const [{ list, live }, nudges] = await Promise.all([readOwnerQueue(sources), readNudges(sources)]);
  const derived = await readDerived(sources, live);
  return { ...list, gaps: [...list.gaps, ...derived.gaps], derived: derived.value, nudges };
}

export function inboxViewCommands(sources: InboxSources) {
  return {
    "inbox.list": readCommand({
      name: "inbox.list",
      description:
        "The owner's inbox: approvals.flow joined to Shepherd's live rows, each item with the one action a tap takes or the terminal command, blocking first and newest first; beside them, machine-derived stall, failed-run and blocked-agent rows with their evidence and no action; and each round open over six hours, once, with its recommendations stated",
      args: z.object({}),
      result: z.custom<InboxView>(),
      run: () => readInboxView(sources),
    }),
  };
}

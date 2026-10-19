/**
 * `inbox.list`: the owner's one inbox, read only. It takes `approvals.flow`'s merged order, joins each factory gate to its
 * live Shepherd row by run id, and gives every item the one action a tap would take, or the terminal command and why the
 * console offers none. A write action (`resolve-gate`, `owner-release`, `hold-release`) comes only from a hitl item joined
 * to a live row: a deposit is agent-written, so it never gets one. Nothing here writes; the actions land in later slices.
 */
import { z } from "zod";
import type { OwnerItem } from "@titan-design/owner-queue";
import { readRoster, type AgentsSource } from "./agents.js";
import { readFlow, type ApprovalsSources } from "./approvals.js";
import { blockedAgentRows, byDerivedOrder, failedRunRows, stalledRunRows, type DerivedRow } from "./inbox-derived.js";
import { readCommand } from "./owner-guard.js";
import type { ShepherdSource } from "./shepherd.js";

export type WatchRow = Awaited<ReturnType<ShepherdSource["list"]>>[number];

type InboxAction =
  | { kind: "resolve-gate"; gateId: string; runId: string; stepId: string; repo: string; pr: number; headSha: string; decision: "merge" }
  | { kind: "owner-release"; repo: string; pr: number; headSha: string }
  | { kind: "hold-release"; repo: string; pr: number; headSha: string; holdClass: string }
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

/** `inbox.list`'s answer: the owner queue, and the machine-derived rows that carry no action. */
export interface InboxView extends InboxList {
  derived: DerivedRow[];
}

export interface InboxSources extends ApprovalsSources {
  shepherd: ShepherdSource;
  /** Optional so test sources need not build one; absent, the inbox derives no blocked-agent rows. */
  agents?: AgentsSource;
  now?: () => number;
}

const MERGE_STEP = "approve-merge";
/** The factory route refuses these to an owner-remote resolver (`batchRefusal`, `DEVICE_RULE`), so the console offers no tap. */
const HARDWARE_STEP = /device|hardware/;
const AFTER_STAGES_STEP = "after-stages";
const OWNER_HOLD_CLASS = "owner-asked";

/** Read as Shepherd's `holdClassOf` reads it: the text before the first colon, untrimmed. */
const holdClassOf = (reason: string): string | undefined => (reason.includes(":") ? reason.slice(0, reason.indexOf(":")) : undefined);

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

function gateStepAction(stepId: string, command: string | undefined): InboxAction | undefined {
  if (HARDWARE_STEP.test(stepId)) return terminal("a device or hardware gate answers only at the device's own terminal", command);
  if (stepId === AFTER_STAGES_STEP) return terminal("an after-stages gate deploys or publishes after the merge; the factory refuses it to the console", command);
  if (stepId !== MERGE_STEP) return terminal(`the console answers approve-merge gates; ${stepId} is answered with its command`, command);
  return undefined;
}

function gateAction(item: OwnerItem, gateId: string, row: WatchRow | undefined): InboxAction {
  const parts = gateParts(gateId);
  if (parts === undefined) return terminal("the gate names no run, so the console cannot read its PR back", item.command);
  const refused = gateStepAction(parts.stepId, item.command);
  if (refused !== undefined) return refused;
  if (row === undefined || row.pr === null || row.headSha === null) return terminal("no live Shepherd row pins this gate's PR and head", item.command);
  return { kind: "resolve-gate", gateId, runId: parts.runId, stepId: parts.stepId, repo: row.repo, pr: row.pr, headSha: row.headSha, decision: "merge" };
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
      return { action: terminal("a deposit is agent-written, so the console offers it no write; run its command", item.command) };
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

function rowOfItem(item: OwnerItem, rows: ReadonlyMap<string, WatchRow>): WatchRow | undefined {
  const source = item.sources[0]!;
  if (source.system !== "hitl") return undefined;
  const runId = gateParts(source.ref)?.runId;
  return runId === undefined ? undefined : rows.get(runId.toLowerCase());
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

async function readInboxView(sources: InboxSources): Promise<InboxView> {
  const { list, live } = await readOwnerQueue(sources);
  const derived = await readDerived(sources, live);
  return { ...list, gaps: [...list.gaps, ...derived.gaps], derived: derived.value };
}

export function inboxViewCommands(sources: InboxSources) {
  return {
    "inbox.list": readCommand({
      name: "inbox.list",
      description:
        "The owner's inbox: approvals.flow joined to Shepherd's live rows, each item with the one action a tap takes or the terminal command, blocking first and newest first; beside them, machine-derived stall, failed-run and blocked-agent rows with their evidence and no action",
      args: z.object({}),
      result: z.custom<InboxView>(),
      run: () => readInboxView(sources),
    }),
  };
}

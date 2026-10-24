/**
 * `inbox.prepare` and `inbox.act`: the owner's tap on an inbox item, in two steps. `prepare` (read) re-reads the item and
 * returns a read-back of what the tap will do, with a confirm digest this console issued and keeps for five minutes. `act`
 * (owner-write) admits only the owner, then re-reads the item and refuses when the digest no longer matches, so a stale screen
 * never posts. It writes the action record once (O_EXCL, 0600) as `<actionsDir>/<confirm>.json`, posts its id to the factory's
 * console-action route, which reads the record and decides, and writes the outcome once beside it. A replay of the same confirm
 * reposts the record it already wrote, byte for byte, so the factory recognises its own resolve and answers `already`. The
 * confirm store and the record and outcome files are the shared kernel in `owner-tap.ts`.
 *
 * An `answer-chat` tap takes the owner's text, keeps it in the same record, and posts it to the agent-chat broker instead. A g10
 * `hold-release` tap reads back the verdicts Shepherd recorded (`g10-hold.ts`) and calls `shepherd.release` itself.
 *
 * An `owner-op` tap (a deposit's typed op on `CONSOLE_OPS`) reads its read-back from the factory's `owner-op.preview`
 * (`inbox-op.ts`) and writes a record naming the `op`, never an `action`, so the factory reads it as an op record.
 *
 * The inbox acts on `resolve-gate`, `owner-release`, `owner-op`, `answer-chat` and a g10 `hold-release`; every other action
 * has no console action.
 */
import { z } from "zod";
import { ownerOpSchema } from "@titan-design/owner-queue";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import type { DecisionItem, DecisionLog, DecisionLogResult } from "./decision-log.js";
import type { AnswerOutcome, BrokerAnswerer } from "./broker-answer.js";
import { g10Signal, isG10Release, releaseG10, type G10Action, type G10Signal } from "./g10-hold.js";
import { nextStateOf, type NextState } from "./inbox-next.js";
import { opReadBackOf, postedOp, type OpAction, type OpReadBack } from "./inbox-op.js";
import { CONSOLE_DECISION_IDS, readInbox, type ConsoleDecision, type InboxItem, type InboxSources } from "./inbox-view.js";
import type { ActionOutcome, OwnerActionClient, Unreachable } from "./owner-action.js";
import { ownerWriteCommand, readCommand } from "./owner-guard.js";
import { CONFIRM, CONFIRM_TTL_MS, digestOf, preparedStore, readSettled, recordOnce, refuse, settleOutcome, writeRecord, type Prepared, type PreparedStore } from "./owner-tap.js";

export const ACTIONS_OFF = "inbox actions are off";
const ACTOR = { class: "owner-remote", id: "titan-console", channel: "console:inbox" } as const;
const MAX_ANSWER = 8000;
const CHANGED = "the item changed since it was read; read it again before confirming";
const DECISION = z.enum(CONSOLE_DECISION_IDS).optional();

type InboxAction = InboxItem["action"];
type PostedAction = Extract<InboxAction, { kind: "resolve-gate" | "owner-release" }>;
type ChatAction = Extract<InboxAction, { kind: "answer-chat" }>;
type ConsoleAction = PostedAction | ChatAction | G10Action | OpAction;
type Outcome = ActionOutcome | Unreachable | AnswerOutcome;

export interface InboxActionOptions {
  /** `TITAN_CONSOLE_INBOX_ACTIONS`; off, both commands answer `inbox actions are off`. */
  enabled: boolean;
  /** The factory's `consoleAnswers.actionsDir`: the factory reads each record from here and nowhere else. */
  actionsDir: string;
  client: OwnerActionClient;
  /** The broker's answer route; absent, an `answer-chat` item has no console action. */
  answerer?: BrokerAnswerer;
  decisionLog?: DecisionLog;
  now?: () => number;
}

type PrReadBack = {
  repo: string;
  pr: number;
  title: string;
  headSha: string;
  gateId?: string;
  hold?: { class: string; reason: string };
  effect: string;
};

type ChatReadBack = {
  msgId: string;
  title: string;
  asker?: string;
  question: string;
  options?: { id: string; label: string }[];
  recommended?: string;
  effect: string;
};

type G10ReadBack = Omit<PrReadBack, "gateId"> & G10Signal;

type ReadBack = PrReadBack | G10ReadBack | ChatReadBack | OpReadBack;

export type PrepareResult =
  | { status: "ready"; itemId: string; action: ConsoleAction; readBack: ReadBack; readAt: string; confirm: string; expiresAt: string }
  | { status: "no-action"; itemId: string; action: InboxAction; reason: string };

type ActResult = {
  actionId: string;
  outcome: Outcome;
  /** One line for the owner, naming what to do next when the tap did not land. */
  message: string;
  log?: DecisionLogResult;
  /** What the PR's run does now, read live after a landed PR tap: merged, a new review, or still pending. */
  next?: NextState;
};

const isPostedAction = (action: InboxAction): action is PostedAction | OpAction => action.kind === "resolve-gate" || action.kind === "owner-release" || action.kind === "owner-op";

const isConsoleAction = (action: InboxAction, answerer: BrokerAnswerer | undefined): action is ConsoleAction => isPostedAction(action) || isG10Release(action) || (action.kind === "answer-chat" && answerer !== undefined);

const short = (sha: string | null): string => (sha === null ? "an unknown head" : sha.slice(0, 7));

/** The read-back is in the digest, so a verdict recorded between the read and the tap refuses the stale confirm. */
const itemDigest = (item: InboxItem, action: InboxAction, readAt: string, readBack: ReadBack): string => digestOf([item.id, action, item.hold ?? null, readBack, readAt]);

function chatReadBackOf(item: InboxItem, action: ChatAction): ChatReadBack {
  const options = item.options?.map(({ id, label }) => ({ id, label }));
  const effect = `Answer ${item.asker ?? "the agent"}'s question; the broker records it as yours`;
  return { msgId: action.msgId, title: item.summary, ...(item.asker && { asker: item.asker }), question: item.context, ...(options && { options }), ...(item.recommended && { recommended: item.recommended.optionId }), effect };
}

const prBaseOf = (item: InboxItem, action: PostedAction | G10Action) => ({ repo: action.repo, pr: action.pr, title: item.summary, headSha: action.headSha, ...(item.hold && { hold: item.hold }) });

/**
 * A g10 release reads the PR's timeline for its verdicts and an op reads the factory's preview; every other read-back comes
 * from the item alone. A string is the reason there is nothing to do.
 */
async function readBackOf(sources: InboxSources, item: InboxItem, action: ConsoleAction): Promise<ReadBack | string> {
  if (action.kind === "answer-chat") return chatReadBackOf(item, action);
  if (action.kind === "owner-op") return opReadBackOf(sources.shepherd, item, action);
  if (action.kind === "hold-release") return { ...prBaseOf(item, action), ...g10Signal((await sources.shepherd.timeline(action.repo, action.pr)).entries, action) };
  const at = `${action.repo}#${action.pr} at ${short(action.headSha)}`;
  if (action.kind === "owner-release") return { ...prBaseOf(item, action), effect: `Release the owner-asked hold on ${at}` };
  return { ...prBaseOf(item, action), gateId: action.gateId, effect: gateEffect(action.decision, at) };
}

const GATE_EFFECT: Record<ConsoleDecision, (at: string) => string> = {
  merge: (at) => `Approve the merge of ${at}`,
  "await-new-head": (at) => `Wait for the implementer's next pushed head on ${at}; nothing merges`,
  "waive-proof": (at) => `Skip the fix-proof requirement for ${at} only, so Shepherd reviews this head. This tap merges nothing: the merge still needs your Approve merge tap, and a new push asks again`,
};

const gateEffect = (decision: ConsoleDecision, at: string): string => GATE_EFFECT[decision](at);

/**
 * The tap the owner chose: the item's own action, or its gate answered with a second decision the item offers. Undefined
 * when the item offers no such tap.
 */
function chosenAction(action: InboxAction, decision: ConsoleDecision | undefined): InboxAction | undefined {
  if (decision === undefined) return action;
  if (action.kind !== "resolve-gate") return undefined;
  return decision === action.decision || action.alternatives?.includes(decision) ? { ...action, decision } : undefined;
}

/** The factory reads a strict action, so the record names the one decision given and none of the item's other taps. */
function postedAction(action: Exclude<ConsoleAction, OpAction>): Exclude<ConsoleAction, OpAction> {
  if (action.kind !== "resolve-gate") return action;
  const { kind, gateId, runId, stepId, repo, pr, headSha, decision } = action;
  return { kind, gateId, runId, stepId, repo, pr, headSha, decision };
}

function noActionReason(action: InboxAction): string {
  if (action.kind === "terminal") return action.reason;
  if (action.kind === "hold-release") return `a ${action.holdClass} hold is released by its seat, not from the inbox`;
  return `a ${action.kind} item is not acted on from the inbox yet`;
}

async function liveItem(sources: InboxSources, itemId: string): Promise<{ item: InboxItem; readAt: string }> {
  const list = await readInbox(sources);
  const item = list.items.find((each) => each.id === itemId);
  return item === undefined ? refuse(`no inbox item ${itemId}; it may have been answered, read the inbox again`) : { item, readAt: list.readAt };
}

async function prepare(ctx: Omit<ActContext, "issuedAt">, store: PreparedStore, { itemId, decision }: Choice): Promise<PrepareResult> {
  const { item, readAt } = await liveItem(ctx.sources, itemId);
  const action = chosenAction(item.action, decision);
  if (action === undefined) return { status: "no-action", itemId, action: item.action, reason: `this item offers no ${decision} tap` };
  if (!isConsoleAction(action, ctx.options.answerer)) return { status: "no-action", itemId, action, reason: noActionReason(action) };
  const readBack = await readBackOf(ctx.sources, item, action);
  if (typeof readBack === "string") return { status: "no-action", itemId, action, reason: readBack };
  const confirm = itemDigest(item, action, readAt, readBack);
  const expiresAt = ctx.now() + CONFIRM_TTL_MS;
  store.remember(confirm, { key: itemId, readAt, expiresAt });
  return { status: "ready", itemId, action, readBack, readAt, confirm, expiresAt: new Date(expiresAt).toISOString() };
}

/** Only the fields the decision log reads go into the record; an absent one is dropped by JSON. */
function decisionItemOf(item: InboxItem): DecisionItem {
  const { id, sources, kind, door, category, summary, options, recommended, keys, initiative, personal, route, openedAt } = item;
  return { id, sources, kind, door, class: item.class, category, summary, options, recommended, keys, initiative, personal, route, openedAt };
}

interface ActContext {
  options: InboxActionOptions;
  sources: InboxSources;
  now: () => number;
  issuedAt: number;
}

/** A fresh tap re-reads the item and writes its record; the digest must still match what the owner was shown. */
async function writeItemRecord(ctx: ActContext, file: string, tap: Tap, prepared: Prepared): Promise<void> {
  const { item } = await liveItem(ctx.sources, prepared.key);
  const action = chosenAction(item.action, tap.decision);
  if (action === undefined || !isConsoleAction(action, ctx.options.answerer)) return refuse(CHANGED);
  const readBack = await readBackOf(ctx.sources, item, action);
  if (typeof readBack === "string" || itemDigest(item, action, prepared.readAt, readBack) !== tap.confirm) return refuse(CHANGED);
  const text = textFor(action, tap.text);
  const target = action.kind === "owner-op" ? ("proposal" in readBack ? { op: postedOp(action.op, readBack) } : { action }) : { action: postedAction(action) };
  const record = { itemId: item.id, ...target, readBack, ...(text !== undefined && { text }), confirm: tap.confirm, readAt: prepared.readAt, item: decisionItemOf(item), session: { issuedAt: ctx.issuedAt }, peer: "lan-remote", at: new Date(ctx.now()).toISOString() };
  await writeRecord(ctx.options.actionsDir, file, record);
}

/** An op record carries no `action`, which is how the factory tells the two apart; it is tried first for that reason. */
const opRecord = z.looseObject({ op: ownerOpSchema, action: z.never().optional(), item: z.custom<DecisionItem>() });
const actionRecord = z.looseObject({ action: z.custom<Exclude<ConsoleAction, OpAction>>((value) => typeof value === "object" && value !== null), item: z.custom<DecisionItem>(), text: z.string().optional() });
const recordFile = z.union([opRecord, actionRecord]);

type OpRecord = z.infer<typeof opRecord>;
type ActionRecord = z.infer<typeof recordFile>;

const isOpRecord = (record: ActionRecord): record is OpRecord => record.action === undefined;

/** An answer needs the owner's words; nothing else takes any, so a stray text is refused rather than dropped. */
function textFor(action: ConsoleAction, text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (action.kind !== "answer-chat") return trimmed === undefined ? undefined : refuse("only an answer to an agent's question takes text");
  return trimmed || refuse("an answer needs text");
}

/** A resolved sent-back gate merged nothing, so its tap must not read as a merge. */
const RESOLVED_MESSAGE: Record<ConsoleDecision, string> = {
  merge: "Merge approved",
  "await-new-head": "Waiting for the implementer's next pushed head; nothing merged",
  "waive-proof": "Fix-proof waived at this head; nothing merged. Shepherd reviews it, and the merge waits for your Approve merge",
};

const resolvedMessage = (record: ActionRecord): string => (!isOpRecord(record) && record.action.kind === "resolve-gate" ? RESOLVED_MESSAGE[record.action.decision] : RESOLVED_MESSAGE.merge);

function messageOf(outcome: Outcome, record: ActionRecord): string {
  switch (outcome.status) {
    case "answered":
      return "Answer sent";
    case "closed":
      return `Not sent; the question is closed, likely answered elsewhere: ${outcome.reason}`;
    case "resolved":
      return resolvedMessage(record);
    case "accepted":
      return `Merge queued: land run ${outcome.runId} merges at this head once its checks are green`;
    case "pr-closed":
      return `PR closed at ${short(outcome.closedHead)}; its branch is kept`;
    case "released":
      return outcome.stillHeld === null ? "Hold released" : `Hold released; the PR is still held: ${outcome.stillHeld}`;
    case "already":
      return "Already done by this confirmation";
    case "moved":
      return `PR moved to ${short(outcome.currentHead)}, read again`;
    case "gone":
      return `Nothing to act on: ${outcome.reason}`;
    case "refused":
      return `Refused (${outcome.reason})${outcome.detail === undefined ? "" : `: ${outcome.detail}`}`;
    case "off":
      return "The factory's console-action route is not mounted; run the item's command on the terminal";
    case "unreachable":
      return `The factory could not be reached, try again: ${outcome.detail}`;
  }
}

/** Settled outcomes are written once, and only the call that wrote a landed one logs the decision. */
async function settle(ctx: ActContext, file: string, record: ActionRecord, outcome: Outcome): Promise<DecisionLogResult | undefined> {
  const wrote = await settleOutcome(file, outcome, new Date(ctx.now()).toISOString());
  if (!wrote || (outcome.status !== "resolved" && outcome.status !== "released" && outcome.status !== "answered")) return undefined;
  const answer = { text: answerTextOf(record), by: ACTOR, at: new Date(ctx.now()).toISOString() };
  return ctx.options.decisionLog?.record(record.item, answer);
}

function answerTextOf(record: ActionRecord): string {
  if (isOpRecord(record)) return record.op.kind;
  const { action, text } = record;
  return action.kind === "answer-chat" ? (text ?? "") : action.kind === "resolve-gate" ? action.decision : "release";
}

/** Shepherd refuses a second release of a lifted hold, so a replay is answered from the outcome this record already settled. */
async function releaseOnce(ctx: ActContext, file: string, confirm: string, action: G10Action): Promise<Outcome> {
  const settled = await readSettled(file);
  if (settled?.status === "released") return { status: "already", ...(settled.runId && { runId: settled.runId }) };
  return releaseG10(ctx.sources.shepherd, action, confirm);
}

/** A replay posts what the record says, so an answer goes out with the words first written, whatever a later tap carries. */
function dispatch(ctx: ActContext, file: string, confirm: string, record: ActionRecord): Promise<Outcome> {
  if (isOpRecord(record)) return ctx.options.client.post(confirm);
  const { action } = record;
  if (action.kind === "hold-release") return releaseOnce(ctx, file, confirm, action);
  if (action.kind !== "answer-chat") return ctx.options.client.post(confirm);
  const { answerer } = ctx.options;
  if (answerer === undefined || record.text === undefined) return Promise.resolve({ status: "unreachable", detail: "the broker answerer is not wired" });
  return answerer.answer(action.msgId, record.text);
}

/** Which tap on an item: its own action, or with `decision` a second tap its gate offers. */
interface Choice {
  itemId: string;
  decision?: ConsoleDecision;
}

interface Tap extends Choice {
  confirm: string;
  text?: string;
}

async function act(ctx: ActContext, store: PreparedStore, tap: Tap): Promise<ActResult> {
  const stale = "the confirmation is unknown or over five minutes old; read the item again";
  const write = (file: string, prepared: Prepared) => writeItemRecord(ctx, file, tap, prepared);
  const { file, record } = await recordOnce({ store, actionsDir: ctx.options.actionsDir, confirm: tap.confirm, key: tap.itemId, stale, schema: recordFile, write });
  const outcome = await dispatch(ctx, file, tap.confirm, record);
  const log = await settle(ctx, file, record, outcome);
  const next = await nextAfter(ctx.sources, record, outcome);
  return { actionId: tap.confirm, outcome, message: messageOf(outcome, record), ...(log !== undefined && { log }), ...(next !== undefined && { next }) };
}

const LANDED: ReadonlySet<Outcome["status"]> = new Set(["resolved", "released", "accepted", "pr-closed", "already"]);

/** Only a landed tap on a PR has a next state to read; an answer to an agent has no run. */
function nextAfter(sources: InboxSources, record: ActionRecord, outcome: Outcome): Promise<NextState | undefined> {
  if (!LANDED.has(outcome.status)) return Promise.resolve(undefined);
  const target = isOpRecord(record) ? record.op : record.action;
  if (!("pr" in target && "headSha" in target)) return Promise.resolve(undefined);
  return nextStateOf(sources.shepherd, { repo: target.repo, pr: target.pr, headSha: target.headSha });
}

const assertOn = (options: InboxActionOptions): void => {
  if (!options.enabled) throw failure(ACTIONS_OFF, EXIT.UNAVAILABLE);
};

export function inboxActionCommands(sources: InboxSources, options: InboxActionOptions) {
  const now = options.now ?? Date.now;
  const store = preparedStore(now);
  return {
    "inbox.prepare": readCommand({
      name: "inbox.prepare",
      description: "Re-read one inbox item and return the read-back of what its tap does, with a confirm digest valid five minutes",
      args: z.strictObject({ itemId: z.string().min(1).max(512), decision: DECISION }),
      result: z.custom<PrepareResult>(),
      run: (choice) => {
        assertOn(options);
        return prepare({ options, sources, now }, store, choice);
      },
    }),
    "inbox.act": ownerWriteCommand({
      name: "inbox.act",
      description: "Do what a prepared inbox item's read-back said: write its action record once and post it to the factory, an answer to the broker, or a g10 release to Shepherd",
      args: z.strictObject({ itemId: z.string().min(1).max(512), decision: DECISION, confirm: z.string().regex(CONFIRM), text: z.string().max(MAX_ANSWER).optional() }),
      result: z.custom<ActResult>(),
      ownerWrite: true,
      run: (args, ctx) => {
        assertOn(options);
        return act({ options, sources, now, issuedAt: ctx.ownerPresence.issuedAt }, store, args);
      },
    }),
  };
}

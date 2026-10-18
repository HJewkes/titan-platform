/**
 * `inbox.prepare` and `inbox.act`: the owner's tap on an inbox item, in two steps. `prepare` (read) re-reads the item and
 * returns a read-back of what the tap will do, with a confirm digest this console issued and keeps for five minutes. `act`
 * (owner-write) admits only the owner, then re-reads the item and refuses when the digest no longer matches, so a stale screen
 * never posts. It writes the action record once (O_EXCL, 0600) as `<actionsDir>/<confirm>.json`, posts its id to the factory's
 * console-action route, which reads the record and decides, and writes the outcome once beside it. A replay of the same confirm
 * reposts the record it already wrote, byte for byte, so the factory recognises its own resolve and answers `already`.
 *
 * This slice acts on `resolve-gate` and `owner-release`; every other action, a deposit's included, has no console action.
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import type { DecisionItem, DecisionLog, DecisionLogResult } from "./decision-log.js";
import { readInbox, type InboxItem, type InboxSources } from "./inbox-view.js";
import type { ActionOutcome, OwnerActionClient, Unreachable } from "./owner-action.js";
import { ownerWriteCommand, readCommand } from "./owner-guard.js";

export const ACTIONS_OFF = "inbox actions are off";
export const CONFIRM_TTL_MS = 5 * 60_000;
const MAX_PREPARED = 256;
const ACTOR = { class: "owner-remote", id: "titan-console", channel: "console:inbox" } as const;
const CONFIRM = /^[0-9a-f]{64}$/;

type InboxAction = InboxItem["action"];
type ConsoleAction = Extract<InboxAction, { kind: "resolve-gate" | "owner-release" }>;

export interface InboxActionOptions {
  /** `TITAN_CONSOLE_INBOX_ACTIONS`; off, both commands answer `inbox actions are off`. */
  enabled: boolean;
  /** The factory's `consoleAnswers.actionsDir`: the factory reads each record from here and nowhere else. */
  actionsDir: string;
  client: OwnerActionClient;
  decisionLog?: DecisionLog;
  now?: () => number;
}

type ReadBack = {
  repo: string;
  pr: number;
  title: string;
  headSha: string;
  gateId?: string;
  hold?: { class: string; reason: string };
  effect: string;
};

export type PrepareResult =
  | { status: "ready"; itemId: string; action: ConsoleAction; readBack: ReadBack; readAt: string; confirm: string; expiresAt: string }
  | { status: "no-action"; itemId: string; action: InboxAction; reason: string };

type ActResult = {
  actionId: string;
  outcome: ActionOutcome | Unreachable;
  /** One line for the owner, naming what to do next when the tap did not land. */
  message: string;
  log?: DecisionLogResult;
};

interface Prepared {
  itemId: string;
  readAt: string;
  expiresAt: number;
}

const isConsoleAction = (action: InboxAction): action is ConsoleAction => action.kind === "resolve-gate" || action.kind === "owner-release";

const short = (sha: string | null): string => (sha === null ? "an unknown head" : sha.slice(0, 7));

const digestOf = (item: InboxItem, readAt: string): string => createHash("sha256").update(JSON.stringify([item.id, item.action, item.hold ?? null, readAt])).digest("hex");

const refuse = (message: string): never => {
  throw failure(message, EXIT.DATAERR);
};

function readBackOf(item: InboxItem, action: ConsoleAction): ReadBack {
  const at = `${action.repo}#${action.pr} at ${short(action.headSha)}`;
  const base = { repo: action.repo, pr: action.pr, title: item.summary, headSha: action.headSha, ...(item.hold && { hold: item.hold }) };
  if (action.kind === "owner-release") return { ...base, effect: `Release the owner-asked hold on ${at}` };
  return { ...base, gateId: action.gateId, effect: `Approve the merge of ${at}` };
}

/** Confirms this console issued, newest last; expired ones are dropped on each prepare, and the oldest past the cap. */
function preparedStore(now: () => number) {
  const issued = new Map<string, Prepared>();
  return {
    remember(confirm: string, entry: Prepared): void {
      for (const [key, value] of issued) if (value.expiresAt <= now()) issued.delete(key);
      issued.set(confirm, entry);
      if (issued.size > MAX_PREPARED) issued.delete(issued.keys().next().value!);
    },
    lookup(confirm: string, itemId: string): Prepared | undefined {
      const entry = issued.get(confirm);
      return entry !== undefined && entry.itemId === itemId && entry.expiresAt > now() ? entry : undefined;
    },
  };
}

type PreparedStore = ReturnType<typeof preparedStore>;

async function liveItem(sources: InboxSources, itemId: string): Promise<{ item: InboxItem; readAt: string }> {
  const list = await readInbox(sources);
  const item = list.items.find((each) => each.id === itemId);
  return item === undefined ? refuse(`no inbox item ${itemId}; it may have been answered, read the inbox again`) : { item, readAt: list.readAt };
}

async function prepare(sources: InboxSources, store: PreparedStore, now: () => number, itemId: string): Promise<PrepareResult> {
  const { item, readAt } = await liveItem(sources, itemId);
  const { action } = item;
  if (!isConsoleAction(action)) return { status: "no-action", itemId, action, reason: action.kind === "terminal" ? action.reason : `a ${action.kind} item is not acted on from the inbox yet` };
  const confirm = digestOf(item, readAt);
  const expiresAt = now() + CONFIRM_TTL_MS;
  store.remember(confirm, { itemId, readAt, expiresAt });
  return { status: "ready", itemId, action, readBack: readBackOf(item, action), readAt, confirm, expiresAt: new Date(expiresAt).toISOString() };
}

/** Only the fields the decision log reads go into the record; an absent one is dropped by JSON. */
function decisionItemOf(item: InboxItem): DecisionItem {
  const { id, sources, kind, door, category, summary, options, recommended, keys, initiative, personal, route, openedAt } = item;
  return { id, sources, kind, door, class: item.class, category, summary, options, recommended, keys, initiative, personal, route, openedAt };
}

const errnoOf = (error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);

/** False when the file already exists. A failed write removes the file it created, so it cannot block a retry. */
async function writeOnce(file: string, bytes: string): Promise<boolean> {
  const handle = await open(file, "wx", 0o600).catch((error: unknown) => (errnoOf(error) === "EEXIST" ? null : Promise.reject(error)));
  if (handle === null) return false;
  try {
    await handle.writeFile(bytes);
  } catch (error) {
    await handle.close();
    await rm(file, { force: true });
    throw error;
  }
  await handle.close();
  return true;
}

interface ActContext {
  options: InboxActionOptions;
  sources: InboxSources;
  now: () => number;
  issuedAt: number;
}

/** A fresh tap re-reads the item and writes its record; the digest must still match what the owner was shown. */
async function writeRecord(ctx: ActContext, file: string, confirm: string, prepared: Prepared): Promise<void> {
  const { item } = await liveItem(ctx.sources, prepared.itemId);
  const { action } = item;
  if (!isConsoleAction(action) || digestOf(item, prepared.readAt) !== confirm) return refuse("the item changed since it was read; read it again before confirming");
  const record = { itemId: item.id, action, readBack: readBackOf(item, action), confirm, readAt: prepared.readAt, item: decisionItemOf(item), session: { issuedAt: ctx.issuedAt }, peer: "lan-remote", at: new Date(ctx.now()).toISOString() };
  await mkdir(ctx.options.actionsDir, { recursive: true, mode: 0o700 });
  await writeOnce(file, `${JSON.stringify(record, null, 2)}\n`);
}

const recordFile = z.looseObject({ action: z.custom<ConsoleAction>(), item: z.custom<DecisionItem>() });

async function readRecord(file: string): Promise<z.infer<typeof recordFile> | undefined> {
  const text = await readFile(file, "utf8").catch((error: unknown) => (errnoOf(error) === "ENOENT" ? undefined : Promise.reject(error)));
  return text === undefined ? undefined : recordFile.parse(JSON.parse(text));
}

function messageOf(outcome: ActionOutcome | Unreachable): string {
  switch (outcome.status) {
    case "resolved":
      return "Merge approved";
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
async function settle(ctx: ActContext, file: string, item: DecisionItem, action: ConsoleAction, outcome: ActionOutcome | Unreachable): Promise<DecisionLogResult | undefined> {
  if (outcome.status === "unreachable" || outcome.status === "off") return undefined;
  const wrote = await writeOnce(file.replace(/\.json$/, ".outcome.json"), `${JSON.stringify({ ...outcome, at: new Date(ctx.now()).toISOString() })}\n`);
  if (!wrote || (outcome.status !== "resolved" && outcome.status !== "released")) return undefined;
  const answer = { text: action.kind === "resolve-gate" ? "merge" : "release", by: ACTOR, at: new Date(ctx.now()).toISOString() };
  return ctx.options.decisionLog?.record(item, answer);
}

async function act(ctx: ActContext, store: PreparedStore, { itemId, confirm }: { itemId: string; confirm: string }): Promise<ActResult> {
  const prepared = store.lookup(confirm, itemId) ?? refuse("the confirmation is unknown or over five minutes old; read the item again");
  const file = path.join(ctx.options.actionsDir, `${confirm}.json`);
  if ((await readRecord(file)) === undefined) await writeRecord(ctx, file, confirm, prepared);
  const record = (await readRecord(file)) ?? refuse("the action record could not be read back");
  const outcome = await ctx.options.client.post(confirm);
  const log = await settle(ctx, file, record.item, record.action, outcome);
  return { actionId: confirm, outcome, message: messageOf(outcome), ...(log !== undefined && { log }) };
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
      args: z.strictObject({ itemId: z.string().min(1).max(512) }),
      result: z.custom<PrepareResult>(),
      run: ({ itemId }) => {
        assertOn(options);
        return prepare(sources, store, now, itemId);
      },
    }),
    "inbox.act": ownerWriteCommand({
      name: "inbox.act",
      description: "Do what a prepared inbox item's read-back said: write its action record once and post it to the factory",
      args: z.strictObject({ itemId: z.string().min(1).max(512), confirm: z.string().regex(CONFIRM) }),
      result: z.custom<ActResult>(),
      ownerWrite: true,
      run: (args, ctx) => {
        assertOn(options);
        return act({ options, sources, now, issuedAt: ctx.ownerPresence.issuedAt }, store, args);
      },
    }),
  };
}
